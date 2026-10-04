@echo off
rem Updates Cache Bell installed from this clone: pulls the clone, then refreshes the catalogue and the plugin.
cd /d "%~dp0" || exit /b 1

rem Started by a double click, the window would close before the result is read: it stays for a while,
rem and goes at a key. Where nobody is at the keyboard the wait ends by itself.
set "HOLD="
echo %cmdcmdline% | "%SystemRoot%\System32\find.exe" /i "%~nx0" >nul && set HOLD="%SystemRoot%\System32\timeout.exe" /t 20 2^>nul

where claude >nul 2>nul
if errorlevel 1 (
  echo The command 'claude' was not found. Install Claude Code first.
  %HOLD%
  exit /b 1
)

rem Only what can be fast-forwarded: local changes in the clone are never overwritten.
call git pull --ff-only
if errorlevel 1 (
  %HOLD%
  exit /b 1
)
call claude plugin marketplace update cache-bell
if errorlevel 1 (
  %HOLD%
  exit /b 1
)
call claude plugin update cache-bell@cache-bell
if errorlevel 1 (
  %HOLD%
  exit /b 1
)

echo.
echo Cache Bell is up to date. Sessions that are open pick it up with /reload-plugins; new ones have it.
%HOLD%
exit /b 0
