@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
REM ============================================================
REM  pi-search-boost — one-click installer (Windows)
REM  Installs the extension into ~/.pi/agent/extensions/search-boost
REM ============================================================

set "SRC=%~dp0"
set "DEST=%USERPROFILE%\.pi\agent\extensions\search-boost"

echo.
echo  ============================================
echo   pi-search-boost installer (Windows)
echo  ============================================
echo   Source : %SRC%
echo   Target : %DEST%
echo.

REM ---- locate pi ----
where pi >nul 2>nul
if errorlevel 1 (
    echo  [WARN] `pi` not found on PATH. Install pi first:
    echo         https://github.com/earendil-works/pi-coding-agent
    echo         The extension files are still copied; enable them after pi is installed.
    echo.
)

REM ---- copy files ----
if not exist "%DEST%" mkdir "%DEST%"
if not exist "%DEST%\lib" mkdir "%DEST%\lib"

copy /Y "%SRC%index.ts" "%DEST%\index.ts" >nul
if errorlevel 1 (
    echo  [ERROR] Failed to copy index.ts. Aborting.
    exit /b 1
)
for %%F in ("%SRC%lib\*.ts") do (
    copy /Y "%%F" "%DEST%\lib\" >nul
    if errorlevel 1 (
        echo  [ERROR] Failed to copy %%~nxF. Aborting.
        exit /b 1
    )
)
echo  [OK] Files copied.

REM ---- optional env keys ----
echo.
echo  ============================================
echo   Optional API keys (skip all = keyless free layer:
echo   exa-free via /web_change free, plus Jina Reader for fetch_page)
echo  ============================================
echo.
set "KEY_NONE=1"

set /p "TAVILY=  Tavily key (recommended, best quality) [Enter to skip]: "
if not "%TAVILY%"=="" (
    setx PI_SEARCH_TAVILY_KEY "%TAVILY%" >nul
    echo   [OK] PI_SEARCH_TAVILY_KEY set
    set "KEY_NONE=0"
)

set /p "EXA=  Exa key (semantic search) [Enter to skip]: "
if not "%EXA%"=="" (
    setx PI_SEARCH_EXA_KEY "%EXA%" >nul
    echo   [OK] PI_SEARCH_EXA_KEY set
    set "KEY_NONE=0"
)

set /p "BRAVE=  Brave key (keyword search) [Enter to skip]: "
if not "%BRAVE%"=="" (
    setx PI_SEARCH_BRAVE_KEY "%BRAVE%" >nul
    echo   [OK] PI_SEARCH_BRAVE_KEY set
    set "KEY_NONE=0"
)

REM ---- verify ----
echo.
echo  ============================================
echo   Verification
echo  ============================================
if "%KEY_NONE%"=="1" (
    echo   [INFO] No API keys configured - using free layer (exa-free + jina).
)
echo   Extension installed at: %DEST%
echo.
echo   Next steps:
echo     1. Restart pi (or run /reload in the TUI)
echo     2. Test:  pi -e "%DEST%\index.ts" -p "fused_search test"
echo     3. See README.md for tools, commands, and usage
echo.
echo   Get free API keys:
echo     Tavily : https://tavily.com   (1000 free credits/mo)
echo     Exa    : https://exa.ai
echo     Brave  : https://brave.com/search/api/
echo.
echo   Done!
echo.
pause
endlocal
