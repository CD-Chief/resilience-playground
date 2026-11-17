# Runs Terraform in Docker against infra/terraform. Arguments pass through:
#
#   $env:HCLOUD_TOKEN = '...'; $env:CLOUDFLARE_API_TOKEN = '...'
#   .\scripts\tf.ps1 plan
#   .\scripts\tf.ps1 output -raw ipv4
$ErrorActionPreference = 'Stop'
$TerraformImage = 'hashicorp/terraform:1.17.1'
$Root = Split-Path -Parent $PSScriptRoot
$Work = (Resolve-Path (Join-Path $Root 'infra/terraform')).Path

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Missing required tool: docker. If you just installed it, open a new terminal.'
}
docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop and try again.' }

if (@('plan', 'apply', 'destroy', 'import', 'refresh') -contains $args[0]) {
    if (-not $env:HCLOUD_TOKEN) { throw 'HCLOUD_TOKEN is not set. Set your Hetzner Cloud API token first.' }
    if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'CLOUDFLARE_API_TOKEN is not set. Set your Cloudflare API token first.' }
}

# Tokens go in by name only, so they never show up in the process list.
$dockerArgs = @('run', '--rm')
if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) { $dockerArgs += '-it' }
if ($env:HCLOUD_TOKEN) {
    $env:TF_VAR_hcloud_token = $env:HCLOUD_TOKEN
    $dockerArgs += @('-e', 'TF_VAR_hcloud_token')
}
if ($env:CLOUDFLARE_API_TOKEN) {
    $env:TF_VAR_cloudflare_api_token = $env:CLOUDFLARE_API_TOKEN
    $dockerArgs += @('-e', 'TF_VAR_cloudflare_api_token')
}
$dockerArgs += @('-v', "${Work}:/workspace", '-w', '/workspace', $TerraformImage)
$dockerArgs += @($args)

& docker @dockerArgs
exit $LASTEXITCODE
