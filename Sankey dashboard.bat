@echo off
rem Double-click launcher for the openLCA Sankey dashboard GUI.
rem Uses pythonw so no console window sits behind the app; falls back to
rem python (and keeps the window open) if pythonw is not on PATH, because the
rem error message is the only thing worth seeing at that point.

cd /d "%~dp0"

where pythonw >nul 2>&1
if %errorlevel%==0 (
    start "" pythonw "sankey_gui.py"
    exit /b 0
)

where python >nul 2>&1
if %errorlevel%==0 (
    python "sankey_gui.py"
    if errorlevel 1 pause
    exit /b 0
)

echo Python was not found on PATH.
echo Install Python 3.9 or newer from https://www.python.org/downloads/windows/
echo and tick "Add python.exe to PATH" during setup.
pause
