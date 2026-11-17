# Production runbook

This is how to run the playground for real at `https://lab.chiefosei.dev`: one Hetzner Cloud server running k3s, behind Cloudflare. Terraform creates the server, firewall and DNS records. Ansible sets the server up and deploys the app. Both run inside Docker, so you do not install either one.

Cost: a few euros a month. Check the Hetzner console for the current price. Running `.\scripts\tf.ps1 destroy` deletes the server and the DNS records and stops the billing (see [Tear it down](#tear-it-down)).

Commands are for PowerShell on Windows, run from the repo root. Git Bash versions are given only where they differ.

## What you need

- Docker Desktop, running.
- Git Bash (it comes with Git for Windows). Only `scripts/set-image-tag.sh` needs it.
- An SSH client (`ssh` ships with Windows 11).
- A Hetzner Cloud account (new), and the Cloudflare account that holds `chiefosei.dev`.

## One-time setup

### 1. Hetzner account and token

1. Create a Hetzner Cloud account and a project called `resilience-playground`.
2. In the project, go to Security, then API tokens, and create a token with Read & Write. Copy it now. Hetzner shows it once.
3. Check in the console that server type `cx23` is available in location `nbg1` (Nuremberg). If not, pick another type or location and set `server_type` or `location` in `terraform.tfvars` (step 5). `cpx22` is the suggested alternative.

### 2. Cloudflare token and zone id

1. In Cloudflare go to My Profile, API Tokens, Create Token. Give it one permission: Zone, DNS, Edit. Limit it to the zone `chiefosei.dev` only. Copy it.
2. Open the `chiefosei.dev` overview page. The Zone ID is in the API section on the right. Copy it.

### 3. Cloudflare SSL mode

The zone's SSL/TLS mode must be Full (strict). This setting covers the whole zone, so first check that your other subdomains on `chiefosei.dev` have valid certificates on their servers. If one does not, Full (strict) will break it. Terraform does not change this setting.

### 4. SSH key and your IP

Make a key if you do not have one (press Enter to accept the defaults):

```powershell
ssh-keygen -t ed25519
```

Show the public key. You will paste it into `terraform.tfvars`:

```powershell
Get-Content $HOME\.ssh\id_ed25519.pub
```

Find your public IPv4 address. SSH to the server will be allowed from this address only:

```powershell
Invoke-RestMethod https://api4.ipify.org
```

If your key is somewhere else, set `$env:SSH_KEY = 'C:\path\to\key'` in each window that runs the Ansible script.

### 5. Create `terraform.tfvars`

```powershell
Copy-Item infra\terraform\terraform.tfvars.example infra\terraform\terraform.tfvars
notepad infra\terraform\terraform.tfvars
```

Set these three values:

- `cloudflare_zone_id`: the Zone ID from step 2.
- `ssh_public_key`: the whole line printed by the `Get-Content` command above.
- `admin_cidrs`: your IP from step 4 with `/32` added, for example `["203.0.113.7/32"]`.

This file is git-ignored. It holds no tokens. Do not put tokens in any file.

### 6. Set the tokens in your shell

```powershell
$env:HCLOUD_TOKEN = 'paste-hetzner-token-here'
$env:CLOUDFLARE_API_TOKEN = 'paste-cloudflare-token-here'
```

These last for the current PowerShell window only. Do not save them in a file and do not commit them. Open a new window and you must set them again. (Git Bash: `export HCLOUD_TOKEN='...'`.)

## First deploy

### 7. Create the server

Download the Terraform providers:

```powershell
.\scripts\tf.ps1 init
```

Success: the output ends with "Terraform has been successfully initialized".

Preview what will be created. This changes nothing:

```powershell
.\scripts\tf.ps1 plan
```

Success: it lists a server, a firewall, an SSH key and two DNS records (A and AAAA), and ends with "Plan: ... to add". Read it before going on.

Create them. This is the step that starts the billing:

```powershell
.\scripts\tf.ps1 apply
```

Type `yes` when asked. Success: "Apply complete", and it prints the server's IP. Terraform keeps its record of what exists in `infra/terraform/terraform.tfstate` (git-ignored). Do not delete it. Without it Terraform forgets the server.

### 8. Set up the server

```powershell
.\scripts\infra-ansible.ps1 site -FirstRun
```

Git Bash: `scripts/infra-ansible.sh site --first-run`.

This builds the Ansible image, then connects to the new server as `root` once. It upgrades the system, turns on automatic security updates and fail2ban, creates the `deploy` user with your key, and then disables root SSH login and password login. It installs k3s, Argo Rollouts and cert-manager, and stores the Cloudflare token as a Secret in the cluster so cert-manager can get a certificate. It waits for the node to be Ready.

Success: the run ends with a PLAY RECAP showing `failed=0`. This takes several minutes.

If it cannot connect, the server may still be booting. Wait a minute and run it again. It is safe to repeat.

After this, root cannot log in. Every later run uses the `deploy` user, so leave off the flag:

```powershell
.\scripts\infra-ansible.ps1 site
```

You only need to re-run `site` after changing the Ansible files or to refresh the Cloudflare token.

### 9. Pick the image tag

GitHub Actions builds the images on every push to `main` that touches `apps/`. On GitHub, open the repo's Actions tab, then the latest `images` run, and wait for it to turn green. Its summary page shows a line like `SHA7: 1a2b3c4`. That is the 7-character tag for that build.

Use the SHA7 of the run that built the images, not of a later commit that only changed docs or the overlay.

Point the prod overlay at it. The script is bash, so run it from Git Bash:

```bash
scripts/set-image-tag.sh 1a2b3c4
```

Or from PowerShell, if `bash` is on your PATH:

```powershell
bash scripts/set-image-tag.sh 1a2b3c4
```

Success: it prints `updated:` for two files under `k8s/overlays/prod` and lists the tags. Commit and push, so the repo records what is deployed:

```powershell
git add k8s/overlays/prod
git commit -m "Deploy 1a2b3c4"
git push
```

### 10. Deploy

```powershell
.\scripts\infra-ansible.ps1 deploy
```

This copies `k8s/` to the server, applies the prod overlay, and waits until the controller, web, loadgen and Prometheus are rolled out, the `target` Rollout is Healthy, and the TLS certificate is Ready. It prints the URL when done.

Success: the run ends with the URL and `failed=0`. The certificate can take a few minutes the first time.

### 11. Open the site

Go to https://lab.chiefosei.dev. You should see the pod grid and the fault buttons.

If an image pull ever fails (pods in `ImagePullBackOff`), check that the package is public: on GitHub, open the repo's Packages and confirm each of the four images (`target`, `loadgen`, `controller`, `web`) is set to Public. You can also test from any machine with `docker pull ghcr.io/cd-chief/resilience-playground/web:<SHA7>` while logged out.

## Everyday tasks

### Deploy a new version

1. Push your change to `main` and wait for the `images` run to go green.
2. Copy the SHA7 from the run summary.
3. `bash scripts/set-image-tag.sh <SHA7>` (or run it in Git Bash without `bash`).
4. Commit and push the overlay change.
5. `.\scripts\infra-ansible.ps1 deploy`

### Reach kubectl

The Kubernetes API (port 6443) is closed to the internet. You reach it through an SSH tunnel. Open one PowerShell window and leave it running:

```powershell
.\scripts\infra-ansible.ps1 tunnel
```

It prints a command to fetch the kubeconfig. Run it once, in another window. This PowerShell version avoids the wrong file encoding that `>` produces. Replace `<IP>` with the IP the tunnel window prints:

```powershell
New-Item -ItemType Directory -Force $HOME\.kube | Out-Null
ssh -i $HOME\.ssh\id_ed25519 deploy@<IP> sudo cat /etc/rancher/k3s/k3s.yaml | Out-File -Encoding ascii $HOME\.kube\resilience-playground.yaml
```

Then, in any window, with the tunnel still running:

```powershell
$env:KUBECONFIG = "$HOME\.kube\resilience-playground.yaml"
kubectl get pods -A
```

Success: you see the pods in `sandbox`, `platform`, `monitoring`, `argo-rollouts` and `cert-manager`. The file's server stays `https://127.0.0.1:6443`, which is the tunnel's local end.

### Your home IP changed

SSH is allowed from your IP only, so a new IP locks you out. Edit `admin_cidrs` in `infra\terraform\terraform.tfvars` to your new `/32` (find it with the command in step 4), set the two tokens in your shell, and run:

```powershell
.\scripts\tf.ps1 apply
```

It only updates the firewall rule.

### Tear it down

```powershell
.\scripts\tf.ps1 destroy
```

Type `yes`. This deletes the server, the firewall, the SSH key and the DNS records for `lab.chiefosei.dev`, and the billing stops. Everything on the server is lost, including incident history. You can build it all again from step 7. Check the Hetzner console afterwards to confirm no server is left.

## Security model

- **Cloudflare proxy.** Visitors reach Cloudflare, not the server. The server's IP is not in public DNS records for the site. Cloudflare terminates TLS for visitors and re-encrypts to the server (Full strict) using a Let's Encrypt certificate.
- **Firewall (Hetzner).** Ports 80 and 443 accept traffic from Cloudflare's IP ranges only. Port 22 accepts traffic from `admin_cidrs` only. Port 6443 is closed. Terraform refuses `0.0.0.0/0` for SSH.
- **SSH.** Keys only. Root login and password login are off. `fail2ban` is on.
- **Rate limits.** The controller limits each client IP (IPv6 per /64) to 4 fault requests a minute and 30 an hour, 6 open live views per IP, and 1000 live views in total. It reads the client IP from the `CF-Connecting-IP` header that Cloudflare sets. The env vars are `FAULT_LIMIT_PER_MINUTE`, `FAULT_LIMIT_PER_HOUR`, `MAX_STREAMS_PER_IP` and `MAX_STREAMS_TOTAL`.
- **Secrets.** The Hetzner and Cloudflare tokens live only in your shell's environment variables, and are passed into containers by name. The one secret on the cluster is `cloudflare-api-token` in the `cert-manager` namespace, created by Ansible. Nothing secret is in git.
- **Updates.** Security updates install automatically. Pinned versions of k3s, Argo Rollouts and cert-manager are in `infra/ansible/group_vars/all.yml`.

## Troubleshooting

- **The certificate is stuck (the deploy times out waiting for it).** Check the Cloudflare token is correct and has Zone, DNS, Edit on the right zone. Then, with the tunnel up:

  ```powershell
  kubectl -n platform describe certificate playground-tls
  kubectl -n cert-manager logs deployment/cert-manager
  ```

  If the token was wrong, set `$env:CLOUDFLARE_API_TOKEN` to the right one, run `.\scripts\infra-ansible.ps1 site`, then `deploy` again.
- **Cloudflare error 522 (connection timed out).** Cloudflare cannot reach the server. Check the server is running in the Hetzner console, and that the firewall still admits Cloudflare on 80 and 443. Run `.\scripts\tf.ps1 plan` to see any drift. Also check that k3s is up with `ssh deploy@<IP> sudo k3s kubectl get nodes`.
- **Cloudflare error 525 or 526.** The zone's SSL mode or the origin certificate is wrong. Confirm Full (strict) and that the certificate is Ready.
- **The live view does not update.** Something in the path is buffering the event stream. The controller sends a heartbeat every 15 seconds, so a healthy stream is never silent for long. Check you are not behind a proxy or a VPN that buffers responses, and try another network.
- **`tf.ps1` or `infra-ansible.ps1` says a token is not set.** Tokens are per window. Set `$env:HCLOUD_TOKEN` and `$env:CLOUDFLARE_API_TOKEN` again.
- **SSH key not found.** The script looks for `$HOME\.ssh\id_ed25519`. Set `$env:SSH_KEY` to your private key path.
- **Docker is not running.** Start Docker Desktop and run the command again.
