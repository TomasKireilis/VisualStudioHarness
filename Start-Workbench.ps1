param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if (!$node) { throw 'Install Node.js 22 or newer, then run Start-Workbench.ps1 again.' }
$nodeVersion = & $node.Source --version
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw "Node.js 22 or newer is required; found $nodeVersion." }
if ($env:AIWORK_EXECUTION -ne 'host') {
    $dockerCommand = if ($env:AIWORK_DOCKER_EXE) { $env:AIWORK_DOCKER_EXE } else { 'docker' }
    if (!(Get-Command $dockerCommand -ErrorAction SilentlyContinue)) { throw 'Install Docker Desktop and start its Linux container engine, then run this launcher again.' }
    # The dashboard starts even while Docker is stopped. Workspace recovery starts
    # Docker Desktop and reports failures in the dashboard, where they can be retried.
}
if (!$env:AIWORK_ROOT) { $env:AIWORK_ROOT = Join-Path $PSScriptRoot '.local\workspaces' }
$env:AIWORK_OPEN_BROWSER = if ($NoBrowser) { 'false' } else { 'true' }
Write-Host 'Starting the local dashboard. Keep this terminal open; Ctrl+C stops the server.'
& $node.Source src/server.js
exit $LASTEXITCODE
