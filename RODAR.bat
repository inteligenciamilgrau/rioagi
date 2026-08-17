@echo off
REM ---------------------------------------------------------------
REM  Operacao RIO-AGI - lancador
REM  Clique duas vezes. Ele procura o node sozinho em varios lugares,
REM  sobe o servidor e abre o navegador.
REM ---------------------------------------------------------------
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "NODEDIR="

REM --- 1) node ja no PATH do sistema? ---
where node.exe >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%P in ('where node.exe') do (
    if not defined NODEDIR set "NODEDIR=%%~dpP"
  )
)

REM --- 2) locais conhecidos (o mais recente primeiro) ---
if not defined NODEDIR (
  for %%D in (
    "E:\projetos_IA\apps\node-v24.15.0-win-x64"
    "D:\projetos_IA\apps\node-v24.15.0-win-x64"
    "C:\Users\%USERNAME%\Documents\PythonScripts\projetos_IA\apps\node-v24.15.0-win-x64"
    "C:\Users\%USERNAME%\Documents\PythonScripts\projetos_IA_old\apps\node-v24.15.0-win-x64"
    "C:\Program Files\nodejs"
  ) do (
    if not defined NODEDIR if exist "%%~D\node.exe" set "NODEDIR=%%~D"
  )
)

REM --- 3) varredura por qualquer pasta node-v* em projetos_IA ---
if not defined NODEDIR (
  for %%R in (E: D: C:) do (
    if not defined NODEDIR (
      for /d %%N in ("%%R\projetos_IA\apps\node-v*") do (
        if not defined NODEDIR if exist "%%~N\node.exe" set "NODEDIR=%%~N"
      )
    )
  )
)

if not defined NODEDIR (
  echo.
  echo  [ERRO] Nao encontrei o node.exe.
  echo.
  echo  Procurei no PATH e nestas pastas:
  echo    E:\projetos_IA\apps\node-v24.15.0-win-x64
  echo    D:\projetos_IA\apps\node-v24.15.0-win-x64
  echo    C:\Users\%USERNAME%\Documents\PythonScripts\projetos_IA\apps\...
  echo.
  echo  Se o node estiver em outro lugar, edite este .bat
  echo  e acrescente o caminho na lista acima.
  echo.
  pause
  exit /b 1
)

set "PATH=%NODEDIR%;%PATH%"
echo.
echo  node encontrado em: %NODEDIR%
for /f "delims=" %%V in ('node --version') do echo  versao: %%V

if not exist "node_modules\vite" (
  echo.
  echo  Primeira execucao: instalando dependencias, aguarde...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  [ERRO] npm install falhou.
    pause
    exit /b 1
  )
)

echo.
echo  ================================================
echo   OPERACAO RIO-AGI
echo  ================================================
echo.
echo   Servidor: http://127.0.0.1:5173/
echo.
echo   Paginas:
echo     /                     jogo completo
echo     /test/world.html      a favela (camera livre)
echo     /test/materials.html  vitrine de materiais
echo     /test/player.html     armas e movimento
echo     /test/core.html       ceu, luz e pos-processamento
echo.
echo   Para parar: feche esta janela ou aperte Ctrl+C
echo.

start "" http://127.0.0.1:5173/test/world.html
call npm run dev

pause
