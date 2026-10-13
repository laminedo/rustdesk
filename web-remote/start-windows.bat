@echo off
REM Double-click this file to start Remote on Windows.
cd /d "%~dp0"
if not exist .venv (
  echo First run: installing ^(takes a minute^)...
  py -3 -m venv .venv || python -m venv .venv
  .venv\Scripts\pip install -q -r requirements.txt
)
.venv\Scripts\python server.py %*
pause
