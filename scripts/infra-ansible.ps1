# Runs Ansible in Docker against the Terraform-created server.
#
#   .\scripts\infra-ansible.ps1 site -FirstRun   # fresh server: connects as root
#   .\scripts\infra-ansible.ps1 site             # later runs: connects as deploy
#   .\scripts\infra-ansible.ps1 deploy           # applies the prod overlay
#   .\scripts\infra-ansible.ps1 tunnel           # SSH tunnel to the Kubernetes API
#
# $env:SSH_KEY overrides the private key (default ~\.ssh\id_ed25519).
# $env:CLOUDFLARE_API_TOKEN must be set in the shell for `site`.
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('site', 'deploy', 'tunnel')]
    [string]$Command,
    [switch]$FirstRun
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Image = 'resilience-playground/ansible:local'
$SshKey = if ($env:SSH_KEY) { $env:SSH_KEY } else { Join-Path $HOME '.ssh\id_ed25519' }

function Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

if ($FirstRun -and $Command -ne 'site') { throw '-FirstRun only applies to the site command.' }
if (-not (Test-Path -LiteralPath $SshKey)) { throw "SSH key not found: $SshKey (set `$env:SSH_KEY to override)" }
$SshKey = (Resolve-Path -LiteralPath $SshKey).Path

Step 'Reading the server IP from Terraform'
$Ip = (& (Join-Path $PSScriptRoot 'tf.ps1') output -raw ipv4 | Out-String).Trim()
if ($Ip -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw "Could not read a server IP from Terraform (got '$Ip'). Has 'scripts\tf.ps1 apply' run?"
}

if ($Command -eq 'tunnel') {
    Write-Host "Kubernetes API tunnel to $Ip. Leave this running and use kubectl in another terminal."
    Write-Host 'Fetch the kubeconfig once (its server stays https://127.0.0.1:6443):'
    Write-Host ''
    # Out-File with ascii: a plain '>' in Windows PowerShell 5.1 writes UTF-16, which kubectl cannot read.
    Write-Host "  ssh -i `"$SshKey`" deploy@$Ip sudo cat /etc/rancher/k3s/k3s.yaml | Out-File -Encoding ascii `$HOME\.kube\resilience-playground.yaml"
    Write-Host ''
    & ssh -i $SshKey -N -L 6443:127.0.0.1:6443 "deploy@$Ip"
    exit $LASTEXITCODE
}

if ($Command -eq 'site') {
    $Playbook = 'site.yml'
    if (-not $env:CLOUDFLARE_API_TOKEN) {
        throw 'CLOUDFLARE_API_TOKEN is not set. Set it in your shell and run again.'
    }
}
else {
    $Playbook = 'deploy.yml'
}
$User = if ($FirstRun) { 'root' } else { 'deploy' }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Missing required tool: docker' }
docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop and try again.' }

Step 'Building the Ansible image'
docker build -q -t $Image (Join-Path $Root 'infra\ansible') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'docker build failed' }

Step "Running $Playbook as $User on $Ip"
# The container entrypoint writes the inventory from SERVER_IP, so no IP is
# ever written to the repo.
& docker run --rm `
    -v "${Root}:/work" `
    -v "${SshKey}:/keys/src:ro" `
    -e CLOUDFLARE_API_TOKEN `
    -e "SERVER_IP=$Ip" `
    $Image `
    ansible-playbook -i /tmp/inventory -e "ansible_user=$User" $Playbook
exit $LASTEXITCODE
