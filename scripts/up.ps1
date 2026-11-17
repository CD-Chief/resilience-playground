# Creates the local k3d cluster (or reuses it), builds the images and deploys
# everything. Safe to run again after changing code.
#
#   .\scripts\up.ps1 -Port 9000     # serve on another local port (first run only)
param(
    [string]$Cluster = 'resilience-playground',
    [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
$ArgoRolloutsVersion = 'v1.10.2'
$Root = Split-Path -Parent $PSScriptRoot
$Context = "k3d-$Cluster"

function Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

# Runs a command and stops the script if it fails.
function Run {
    $exe = $args[0]
    $rest = @($args | Select-Object -Skip 1)
    & $exe @rest
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $exe $($rest -join ' ')" }
}

# Every kubectl call names the context, so this can never touch another cluster.
function K { Run kubectl --context $Context @args }

foreach ($tool in 'docker', 'k3d', 'kubectl') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "Missing required tool: $tool. If you just installed it, open a new terminal."
    }
}
docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop and try again.' }

$clusters = @(k3d cluster list --no-headers | ForEach-Object { ($_ -split '\s+')[0] })
$existed = $clusters -contains $Cluster
if ($existed) {
    Step "Using existing cluster '$Cluster'"
}
else {
    Step "Creating cluster '$Cluster' (http://localhost:$Port)"
    Run k3d cluster create $Cluster --port "${Port}:80@loadbalancer" --kubeconfig-switch-context=false --wait --timeout 180s
}

Step 'Building images'
Run docker build -q -t resilience-playground/target:v1 --build-arg VERSION=v1 "$Root/apps/target"
Run docker build -q -t resilience-playground/target:v2-broken --build-arg VERSION=v2-broken --build-arg BROKEN=true "$Root/apps/target"
Run docker build -q -t resilience-playground/target:v2-flaky --build-arg VERSION=v2-flaky --build-arg ERROR_RATE=0.5 "$Root/apps/target"
Run docker build -q -t resilience-playground/loadgen:v1 "$Root/apps/loadgen"
Run docker build -q -t resilience-playground/controller:v1 "$Root/apps/controller"
Run docker build -q -t resilience-playground/web:v1 "$Root/apps/web"

Step 'Importing images into the cluster'
Run k3d image import --cluster $Cluster `
    resilience-playground/target:v1 `
    resilience-playground/target:v2-broken `
    resilience-playground/target:v2-flaky `
    resilience-playground/loadgen:v1 `
    resilience-playground/controller:v1 `
    resilience-playground/web:v1

Step "Installing Argo Rollouts $ArgoRolloutsVersion"
$namespaces = @(kubectl --context $Context get namespaces -o name)
if ($namespaces -notcontains 'namespace/argo-rollouts') { K create namespace argo-rollouts }
# Server-side apply: the CRDs are too large for a client-side apply.
K apply --server-side --force-conflicts -n argo-rollouts -f "https://github.com/argoproj/argo-rollouts/releases/download/$ArgoRolloutsVersion/install.yaml" | Out-Null
K wait --for=condition=Established crd/rollouts.argoproj.io --timeout=60s | Out-Null
K -n argo-rollouts rollout status deployment/argo-rollouts --timeout=180s

Step 'Applying manifests'
K apply -k "$Root/k8s"

if ($existed) {
    Step 'Restarting workloads to pick up the rebuilt images'
    K -n platform rollout restart deployment/controller deployment/web
    K -n sandbox rollout restart deployment/loadgen
    # The patch goes through a file because Windows PowerShell mangles JSON
    # passed as a command-line argument.
    $patch = Join-Path ([IO.Path]::GetTempPath()) "rp-restart-$PID.json"
    $restartAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    [IO.File]::WriteAllText($patch, "{`"spec`":{`"restartAt`":`"$restartAt`"}}")
    try { K -n sandbox patch rollout target --type merge --patch-file $patch }
    finally { Remove-Item $patch -ErrorAction SilentlyContinue }
}

Step 'Waiting for everything to be ready'
K -n platform rollout status deployment/controller --timeout=180s
K -n platform rollout status deployment/web --timeout=180s
K -n monitoring rollout status deployment/prometheus --timeout=180s
K -n sandbox rollout status deployment/loadgen --timeout=180s
K -n sandbox wait rollout/target '--for=jsonpath={.status.phase}=Healthy' --timeout=180s

Write-Host ''
Write-Host 'Resilience Playground is running.' -ForegroundColor Green
Write-Host ''
Write-Host "  Open:      http://localhost:$Port"
Write-Host "  Pods:      kubectl --context $Context -n sandbox get pods"
Write-Host "  Traffic:   kubectl --context $Context -n sandbox logs deployment/loadgen -f"
Write-Host '  Stop:      .\scripts\down.ps1'
