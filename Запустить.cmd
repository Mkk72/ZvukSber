@echo off
rem ZvukSber: запуск без установщика.
rem Приоритет — сборка из исходников: она всегда свежая. Готовая сборка в release
rem используется только если исходников/зависимостей нет. Молчит, когда всё в порядке.
setlocal
cd /d "%~dp0"

rem Скрипт должен лежать рядом с package.json: копия в другой папке (например,
rem в release\win-unpacked) ищет node_modules и сборку по неверным путям.
if not exist "%~dp0package.json" (
  echo.
  echo   Запустите "Запустить.cmd" из корня проекта — там, где лежит package.json.
  echo   Текущая папка: %~dp0
  echo.
  pause
  exit /b 1
)

if exist "%~dp0node_modules\electron\dist\electron.exe" (
  where node >nul 2>nul
  if not errorlevel 1 (
    call npx tsc -p tsconfig.json >nul 2>nul
    if errorlevel 1 (
      echo   Сборка TypeScript не удалась. Запустите вручную: npm run build
      pause
      exit /b 1
    )
  )
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox
  exit /b 0
)

if exist "%~dp0release\win-unpacked\ZvukSber.exe" (
  start "" "%~dp0release\win-unpacked\ZvukSber.exe" --no-sandbox
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Для первого запуска нужен Node.js LTS — его нет в PATH.
  echo   Скачать: https://nodejs.org/en/download  ^(msi, установить с галочкой Add to PATH^)
  echo   После установки снова запустите этот файл.
  echo.
  pause
  exit /b 1
)

echo   Зависимостей нет, ставлю (это один раз)...
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
