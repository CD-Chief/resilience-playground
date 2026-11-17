import {
  CoreV1Api,
  CustomObjectsApi,
  DiscoveryV1Api,
  KubeConfig,
  PatchStrategy,
  makeInformer,
  setHeaderOptions,
  type CoreV1Event,
  type Informer,
  type KubernetesListObject,
  type KubernetesObject,
  type ObjectCache,
  type V1EndpointSlice,
  type V1Pod,
} from '@kubernetes/client-node';
import type { Config } from './config.js';
import { errorMessage, log } from './log.js';
import type { ClusterState, LogEntry } from './types.js';
import {
  eventTime,
  latestAnalysis,
  servingIps,
  toLogEntry,
  toPodView,
  toRolloutView,
  type AnalysisRunObject,
  type RolloutObject,
} from './views.js';

const ROLLOUTS = { group: 'argoproj.io', version: 'v1alpha1', plural: 'rollouts' };
const RESTART_DELAY_MS = 2000;
const REPEAT_INTERVAL_MS = 15000;

export interface ClusterHandlers {
  onChange: () => void;
  onEvent: (entry: Omit<LogEntry, 'id'>) => void;
}

/**
 * The controller's only contact with Kubernetes and with the target pods.
 * Every read and write is scoped to the sandbox namespace.
 */
export class Cluster {
  private readonly kc = new KubeConfig();
  private readonly custom: CustomObjectsApi;
  private readonly pods: Informer<V1Pod> & ObjectCache<V1Pod>;
  private readonly slices: Informer<V1EndpointSlice> & ObjectCache<V1EndpointSlice>;
  private readonly rollouts: Informer<KubernetesObject> & ObjectCache<KubernetesObject>;
  private readonly analysisRuns: Informer<KubernetesObject> & ObjectCache<KubernetesObject>;
  private readonly events: Informer<CoreV1Event> & ObjectCache<CoreV1Event>;
  private readonly startedAt = Date.now();
  /** Event uid -> what was last reported for it. */
  private readonly seenEvents = new Map<string, { count: number; reportedAt: number }>();

  constructor(
    private readonly config: Config,
    private readonly handlers: ClusterHandlers,
  ) {
    this.kc.loadFromDefault();
    const core = this.kc.makeApiClient(CoreV1Api);
    const discovery = this.kc.makeApiClient(DiscoveryV1Api);
    this.custom = this.kc.makeApiClient(CustomObjectsApi);
    const namespace = config.namespace;

    this.pods = makeInformer(
      this.kc,
      `/api/v1/namespaces/${namespace}/pods`,
      () => core.listNamespacedPod({ namespace, labelSelector: config.podSelector }),
      config.podSelector,
    );

    const sliceSelector = `kubernetes.io/service-name=${config.serviceName}`;
    this.slices = makeInformer(
      this.kc,
      `/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices`,
      () => discovery.listNamespacedEndpointSlice({ namespace, labelSelector: sliceSelector }),
      sliceSelector,
    );

    this.rollouts = makeInformer(
      this.kc,
      `/apis/${ROLLOUTS.group}/${ROLLOUTS.version}/namespaces/${namespace}/${ROLLOUTS.plural}`,
      () =>
        this.custom.listNamespacedCustomObject({ ...ROLLOUTS, namespace }) as Promise<
          KubernetesListObject<KubernetesObject>
        >,
    );

    this.analysisRuns = makeInformer(
      this.kc,
      `/apis/${ROLLOUTS.group}/${ROLLOUTS.version}/namespaces/${namespace}/analysisruns`,
      () =>
        this.custom.listNamespacedCustomObject({ ...ROLLOUTS, plural: 'analysisruns', namespace }) as Promise<
          KubernetesListObject<KubernetesObject>
        >,
    );

    this.events = makeInformer(this.kc, `/api/v1/namespaces/${namespace}/events`, () =>
      core.listNamespacedEvent({ namespace }),
    );
  }

  async start(): Promise<void> {
    const stateInformers = {
      pods: this.pods,
      endpointslices: this.slices,
      rollouts: this.rollouts,
      analysisruns: this.analysisRuns,
    };
    for (const [name, informer] of Object.entries(stateInformers)) {
      for (const verb of ['add', 'update', 'delete'] as const) {
        informer.on(verb, () => this.handlers.onChange());
      }
      this.keepAlive(name, informer);
    }

    this.events.on('add', (event) => this.reportEvent(event));
    this.events.on('update', (event) => this.reportEvent(event));
    this.events.on('delete', (event) => {
      if (event.metadata.uid) this.seenEvents.delete(event.metadata.uid);
    });
    this.keepAlive('events', this.events);

    await Promise.all([
      this.pods.start(),
      this.slices.start(),
      this.rollouts.start(),
      this.analysisRuns.start(),
      this.events.start(),
    ]);
  }

  /** A watch that drops is restarted; the informer re-lists and catches up. */
  private keepAlive(name: string, informer: Informer<KubernetesObject>): void {
    informer.on('error', (err) => {
      log('warn', 'watch failed, restarting', { watch: name, error: errorMessage(err) });
      setTimeout(() => {
        informer.start().catch((startErr: unknown) => {
          log('error', 'watch restart failed', { watch: name, error: errorMessage(startErr) });
        });
      }, RESTART_DELAY_MS);
    });
  }

  private reportEvent(event: CoreV1Event): void {
    const uid = event.metadata.uid;
    if (!uid) return;
    // Skip history from before this process started.
    if (eventTime(event) < this.startedAt) return;
    // Kubernetes folds a repeating event (a probe failing every 2s, say) into
    // one object with a rising count. Report the first, then at most one
    // repeat per interval, so the log stays readable.
    const count = event.count ?? 1;
    const seen = this.seenEvents.get(uid);
    const now = Date.now();
    if (seen && (seen.count === count || now - seen.reportedAt < REPEAT_INTERVAL_MS)) return;
    this.seenEvents.set(uid, { count, reportedAt: now });
    this.handlers.onEvent(toLogEntry(event));
  }

  state(): ClusterState {
    const rolloutObject = this.rollouts
      .list()
      .find((r) => r.metadata?.name === this.config.rolloutName) as RolloutObject | undefined;
    const rollout = rolloutObject ? toRolloutView(rolloutObject) : null;
    const serving = servingIps(this.slices.list());
    const pods = this.pods
      .list()
      .map((pod) => toPodView(pod, rollout?.stableHash ?? '', serving))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
    const analysis = latestAnalysis(this.analysisRuns.list() as AnalysisRunObject[]);
    return { pods, rollout, analysis };
  }

  /** Call a fault toggle on one target pod's admin port. */
  async callAdmin(podIp: string, path: '/admin/crash' | `/admin/unready?seconds=${number}`): Promise<void> {
    const res = await fetch(`http://${podIp}:${this.config.adminPort}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`target admin answered ${res.status}`);
  }

  /** The controller's one write to Kubernetes: the target Rollout's image. */
  async setRolloutImage(image: string): Promise<void> {
    await this.custom.patchNamespacedCustomObject(
      {
        ...ROLLOUTS,
        namespace: this.config.namespace,
        name: this.config.rolloutName,
        body: [{ op: 'replace', path: '/spec/template/spec/containers/0/image', value: image }],
      },
      setHeaderOptions('Content-Type', PatchStrategy.JsonPatch),
    );
  }
}
