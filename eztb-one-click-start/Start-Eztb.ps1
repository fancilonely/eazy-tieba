# eztb local startup helper for Windows 11 / PowerShell 5.1+
# Place this file beside Start-Eztb.cmd and double-click the CMD file.
# Edit the two paths below if you move Docker Desktop or the project.
$DockerDesktopExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$ProjectDir       = 'D:\tools\eazy-tieba'
$EnvFile          = Join-Path $env:USERPROFILE 'tieba-api.env'
$ContainerName    = 'eztb-api'
$ApiImage         = 'ghcr.io/dilettante258/tieba-api-scf:latest'
$ApiUrl           = 'http://127.0.0.1:8000/health'
$WebUrl           = 'http://localhost:5173/'

$ErrorActionPreference = 'Stop'

function Say([string]$Message) {
    Write-Host "[eztb] $Message" -ForegroundColor Cyan
}
function Fail([string]$Message) {
    throw $Message
}
function Find-Executable([string]$Name, [string[]]$Fallbacks) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($file in $Fallbacks) {
        if (Test-Path -LiteralPath $file -PathType Leaf) { return $file }
    }
    return $null
}
function Test-DockerReady {
    try {
        $null = & $script:DockerExe info --format '{{.ServerVersion}}' 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}
function Test-ApiReady {
    try {
        $data = Invoke-RestMethod -Uri $ApiUrl -Method Get -TimeoutSec 3
        return ($data.status -eq 'ok')
    } catch {
        return $false
    }
}
function Test-WebReady {
    try {
        $resp = Invoke-WebRequest -Uri $WebUrl -UseBasicParsing -TimeoutSec 3
        return ($resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}
function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$Description) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return $true }
        Start-Sleep -Seconds 3
    }
    return [bool](& $Condition)
}

try {
    Say 'Checking project and credentials...'
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir 'package.json') -PathType Leaf)) {
        Fail "Project not found: $ProjectDir. Please check the path at the top of Start-Eztb.ps1."
    }
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
        Fail "Missing $EnvFile. Create a local file containing BDUSS=<your current token>; never share it."
    }
    if ((Get-Content -LiteralPath $EnvFile -Raw) -notmatch '(?m)^\s*BDUSS=\S+') {
        Fail "BDUSS is not configured correctly in $EnvFile. Use BDUSS=value without quotes."
    }

    $script:DockerExe = Find-Executable 'docker.exe' @(
        'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
    )
    if (-not $DockerExe) { Fail 'Docker CLI not found. Install Docker Desktop first.' }

    if (-not (Test-DockerReady)) {
        if (-not (Test-Path -LiteralPath $DockerDesktopExe -PathType Leaf)) {
            Fail "Docker Desktop not found at $DockerDesktopExe. Update the path in this script."
        }
        Say 'Starting Docker Desktop...'
        Start-Process -FilePath $DockerDesktopExe | Out-Null
        Say 'Waiting for Docker engine (up to 180 seconds)...'
        if (-not (Wait-Until { Test-DockerReady } 180 'Docker')) {
            Fail 'Docker engine did not become ready. Open Docker Desktop and check its status.'
        }
    }
    Say 'Docker engine is ready.'

    # Always recreate only our own named container so changes to BDUSS in the
    # local env file take effect. No other Docker containers are touched.
    $previous = & $DockerExe ps -a --filter "name=^/$ContainerName$" --format '{{.Names}}'
    if ($LASTEXITCODE -ne 0) { Fail 'Could not inspect Docker containers.' }
    if (($previous | Out-String).Trim() -eq $ContainerName) {
        Say 'Replacing previous eztb-api container to refresh its environment...'
        & $DockerExe rm -f $ContainerName | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'Could not remove previous eztb-api container.' }
    }

    Say 'Starting local Tieba API on 127.0.0.1:8000...'
    & $DockerExe run --detach --rm --name $ContainerName `
        --publish '127.0.0.1:8000:8000' `
        --env-file $EnvFile `
        $ApiImage | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail 'API container could not start. Check that port 8000 is not already in use.'
    }
    if (-not (Wait-Until { Test-ApiReady } 60 'Tieba API')) {
        Fail 'The API started but its health check failed. Run: docker logs --tail 30 eztb-api (redact any secrets before sharing).'
    }
    Say 'Tieba API is healthy.'

    $BunExe = Find-Executable 'bun.exe' @(
        (Join-Path $env:USERPROFILE '.bun\bin\bun.exe')
    )
    if (-not $BunExe) { Fail 'Bun not found. Install Bun and reopen PowerShell, then retry.' }

    $oldLocation = Get-Location
    try {
        Set-Location -LiteralPath $ProjectDir
        $vitePaths = @(
            (Join-Path $ProjectDir 'node_modules\.bin\vite.cmd'),
            (Join-Path $ProjectDir 'node_modules\.bin\vite'),
            (Join-Path $ProjectDir 'apps\web\node_modules\.bin\vite.cmd'),
            (Join-Path $ProjectDir 'apps\web\node_modules\.bin\vite')
        )
        $viteInstalled = @($vitePaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }).Count -gt 0
        if (-not $viteInstalled) {
            $sdkPackage = Join-Path $ProjectDir 'packages\sdk\package.json'
            $apiPackage = Join-Path $ProjectDir 'apps\api\package.json'
            if (-not (Test-Path -LiteralPath $sdkPackage) -or -not (Test-Path -LiteralPath $apiPackage)) {
                $GitExe = Find-Executable 'git.exe' @('C:\Program Files\Git\cmd\git.exe')
                if (-not $GitExe) { Fail 'Git is required to fetch missing submodules.' }
                Say 'Fetching missing Git submodules...'
                & $GitExe submodule update --init --recursive
                if ($LASTEXITCODE -ne 0) { Fail 'Git submodule download failed.' }
            }
            Say 'Vite missing. Installing dependencies with bun install (first run may take a while)...'
            & $BunExe install
            if ($LASTEXITCODE -ne 0) { Fail 'bun install failed. See errors above.' }
        }
    } finally {
        Set-Location -LiteralPath $oldLocation
    }

    if (Test-WebReady) {
        Say 'Port 5173 already responds; reusing the existing web server.'
    } else {
        # Separate PowerShell window, so the dev server stays running after
        # this launcher finishes. Escape apostrophes in Windows paths.
        $runnerPath = Join-Path $env:TEMP 'eztb-vite-runner.ps1'
        $safeProject = $ProjectDir.Replace("'", "''")
        $safeBun = $BunExe.Replace("'", "''")
        $runnerText = @"
Set-Location -LiteralPath '$safeProject'
Write-Host '[eztb] Running Vite. Keep this window open while using the website.' -ForegroundColor Cyan
& '$safeBun' run --cwd apps/web dev
if (`$LASTEXITCODE -ne 0) { Write-Host '[eztb] Vite stopped with an error.' -ForegroundColor Red }
"@
        Set-Content -LiteralPath $runnerPath -Value $runnerText -Encoding UTF8
        Say 'Launching Vite in a separate PowerShell window...'
        Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`"" | Out-Null
        Say 'Waiting for frontend (up to 90 seconds)...'
        if (-not (Wait-Until { Test-WebReady } 90 'Vite')) {
            Fail 'Vite did not become ready. Check the separate PowerShell window for errors.'
        }
    }
    Say 'Success! Opening browser...'
    Say 'Web: http://localhost:5173   API: http://localhost:8000/docs'
    Say 'In eztb Settings, choose: Backend -> Local node.'
    Start-Process $WebUrl | Out-Null
    Write-Host ''
    Write-Host 'To stop API later: docker stop eztb-api' -ForegroundColor Yellow
    Write-Host 'To stop the website: press Ctrl+C in the Vite PowerShell window.' -ForegroundColor Yellow
} catch {
    Write-Host ''
    Write-Host ('[eztb] ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
