@echo off
setlocal

cd /d "%~dp0"

echo Starting CheetahClaws Web UI with DeepSeek V4 Flash (no auth)...
echo Project root: %cd%
echo.

start "CheetahClaws Web NoAuth" cmd /k "cd /d ""%~dp0"" && python cheetahclaws.py --web --no-auth --port 8081 --model deepseek/deepseek-v4-flash"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8081/chat"
exit /b 0
