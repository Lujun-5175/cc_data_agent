@echo off
setlocal

cd /d "%~dp0"

echo Starting CheetahClaws Web UI with DeepSeek V4 Flash...
echo Project root: %cd%
echo.

start "CheetahClaws Web" cmd /k "cd /d ""%~dp0"" && powershell -ExecutionPolicy Bypass -File ""%~dp0start-cheetah-deepseek.ps1"" -Web"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8080/chat"
exit /b 0
