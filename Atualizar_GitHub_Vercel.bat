@echo off
chcp 65001 > nul
title Sincronizar com GitHub e Vercel
echo =========================================================================
echo 💈 Sincronizacao do Sistema SaaS de Barbearia com GitHub e Vercel
echo =========================================================================
echo.
cd /d "%~dp0"
echo [1/2] Verificando alteracoes e preparando envio...
"C:\Program Files\Git\cmd\git.exe" add .
"C:\Program Files\Git\cmd\git.exe" commit -m "chore: sincronizacao automatica com GitHub e Vercel" 2>nul
echo.
echo [2/2] Enviando para https://github.com/santosmartinsbm/saas-gestao-barbearia...
"C:\Program Files\Git\cmd\git.exe" push -u origin main
echo.
if %ERRORLEVEL% EQU 0 (
    echo =========================================================================
    echo ✅ Sucesso! O codigo foi enviado para o GitHub com exito.
    echo 🚀 A Vercel ja iniciou o deploy automatico da nova versao!
    echo =========================================================================
) else (
    echo =========================================================================
    echo ⚠️ Caso seja solicitado login no navegador, autorize o acesso ao GitHub.
    echo =========================================================================
)
echo.
pause
