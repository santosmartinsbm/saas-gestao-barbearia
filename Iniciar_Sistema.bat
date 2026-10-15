@echo off
title Sistema Barbearia - Gestao e Barbeiros
echo ========================================================
echo    INICIANDO SISTEMA DE GESTAO DE BARBEARIA
echo ========================================================
echo.
echo Abrindo painel no modo aplicativo...

set APP_URL=file:///%~dp0index.html

:: Verifica se o Microsoft Edge existe para abrir em modo App nativo
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="%APP_URL%"
    goto FIM
)

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app="%APP_URL%"
    goto FIM
)

:: Verifica se o Google Chrome existe
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app="%APP_URL%"
    goto FIM
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --app="%APP_URL%"
    goto FIM
)

:: Caso nenhum seja encontrado no caminho padrao, abre no navegador padrao do Windows
start "" "%~dp0index.html"

:FIM
exit
