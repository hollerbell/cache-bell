@echo off
rem Installs Cache Bell from this clone: adds the clone as a plugin catalogue, then installs the plugin from it.
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

rem The path has to be ./ here: a bare dot is refused. A catalogue added before is refreshed instead.
call claude plugin marketplace add ./
if errorlevel 1 call claude plugin marketplace update cache-bell
if errorlevel 1 (
  %HOLD%
  exit /b 1
)
call claude plugin install cache-bell@cache-bell
if errorlevel 1 (
  %HOLD%
  exit /b 1
)

echo.
echo Cache Bell is installed. No option has to be set: the defaults work.
echo Start a new Claude Code session; /bell status says what the plugin sees.
echo In every session already open, run /reload-plugins.
%HOLD%
exit /b 0
