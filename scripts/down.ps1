# Deletes the local k3d cluster and everything in it.
param(
    [string]$Cluster = 'resilience-playground'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command k3d -ErrorAction SilentlyContinue)) {
    throw 'Missing required tool: k3d. If you just installed it, open a new terminal.'
}

$clusters = @(k3d cluster list --no-headers | ForEach-Object { ($_ -split '\s+')[0] })
if ($clusters -contains $Cluster) {
    k3d cluster delete $Cluster
    if ($LASTEXITCODE -ne 0) { throw "Could not delete cluster '$Cluster'." }
}
else {
    Write-Host "Cluster '$Cluster' does not exist. Nothing to do."
}
