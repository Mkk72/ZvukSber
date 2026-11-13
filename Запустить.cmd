@echo off
rem ZvukSber: запуск без установщика.
rem Проверяет только то, чего действительно может не хватать, и молчит, если всё есть.
setlocal
cd /d "%~dp0"

if exist "%~dp0release\win-unpacked\ZvukSber.exe" (
  start "" "%~dp0release\win-unpacked\ZvukSber.exe" --no-sandbox
  exit /b 0
)

if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Для первого запуска нужен Node.js LTS — его нет в PATH.
  echo   Скачать: https://nodejs.org/en/download  ^(msi, установить с галочкой Add to PATH^)
  echo   После установки: npm install ^&^& npm start
  echo.
  pause
  exit /b 1
)

echo   Сборка не найдена, собираю из исходников...
call npm install
if errorlevel 1 (
  echo.
  echo   npm install не удался. Проверьте доступ в интернет и повторите.
  echo   Node.js: https://nodejs.org/en/download
  echo.
  pause
  exit /b 1
)
call npm run build
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox
