param(
    [switch]$Web,
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ProjectRoot ".env"
$PythonExe = "python"
$Model = "deepseek/deepseek-v4-flash"

if (-not (Test-Path $EnvFile)) {
    Write-Error ".env not found at $EnvFile"
}

$envMap = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
        return
    }

    $parts = $line.Split("=", 2)
    $key = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($value.Length -ge 2) {
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }
    $envMap[$key] = $value
}

if (-not $envMap.ContainsKey("DEEPSEEK_API_KEY") -or [string]::IsNullOrWhiteSpace($envMap["DEEPSEEK_API_KEY"])) {
    Write-Host "Please add your DeepSeek API key to .env first:" -ForegroundColor Yellow
    Write-Host "  DEEPSEEK_API_KEY=your_key_here" -ForegroundColor Yellow
    exit 1
}

$env:DEEPSEEK_API_KEY = $envMap["DEEPSEEK_API_KEY"]
if ($envMap.ContainsKey("CHEETAHCLAWS_WEB_SECRET") -and -not [string]::IsNullOrWhiteSpace($envMap["CHEETAHCLAWS_WEB_SECRET"])) {
    $env:CHEETAHCLAWS_WEB_SECRET = $envMap["CHEETAHCLAWS_WEB_SECRET"]
}

Set-Location $ProjectRoot

Write-Host "Using model: $Model" -ForegroundColor Cyan

if ($Web) {
    Write-Host "Starting web UI at http://localhost:$Port/chat" -ForegroundColor Green
    & $PythonExe "cheetahclaws.py" "--web" "--port" "$Port" "--model" "$Model"
}
else {
    Write-Host "Starting CLI mode" -ForegroundColor Green
    & $PythonExe "cheetahclaws.py" "--model" "$Model"
}
