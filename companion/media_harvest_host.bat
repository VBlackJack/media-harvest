@echo off
where python >nul 2>&1
if %errorlevel% equ 0 (
  python "%~dp0media_harvest_host.py" %*
  exit /b %errorlevel%
)
py -3 "%~dp0media_harvest_host.py" %*
