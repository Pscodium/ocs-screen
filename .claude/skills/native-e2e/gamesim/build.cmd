@echo off
rem Compila o gamesim.exe (jogo sintético dos testes). Saída em <scratch>\gamesim.exe se %1 for passado,
rem senão ao lado deste arquivo (gamesim.exe está no .gitignore do skill).
setlocal
set OUT=%~1
if "%OUT%"=="" set OUT=%~dp0gamesim.exe
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cl /nologo /O2 /EHsc /std:c++17 "%~dp0gamesim.cpp" /Fe:"%OUT%" /Fo:"%TEMP%\gamesim.obj" /link /SUBSYSTEM:CONSOLE >nul || exit /b 1
echo ok: %OUT%
