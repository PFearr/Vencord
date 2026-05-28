@echo off
setlocal EnableExtensions

@REM Check if they want to continue

set /p ask="This script will install a folder called Vencord to the current directory. You will be able to delete it in the end. Do you want to continue? (y/n): "
if /I not "%ask%"=="y" (
	echo Exiting script.
	exit /b 0
)

@REM Permission to install
set "ALLOW_INSTALL=0"
set /p ask="This script requires Node.js, npm, git, and pnpm to run. If they are not installed, would you like to install them? (y/n): "
if /I "%ask%"=="y" (
	set "ALLOW_INSTALL=1"
) else (
	echo You have chosen not to install dependencies. The script will check them and exit if missing.
)

@REM What package manager do they have?

set "PKG_MANAGER="
where winget >nul 2>nul
if %errorlevel%==0 (
	set "PKG_MANAGER=winget"
) else (
	where choco >nul 2>nul
	if %errorlevel%==0 (
		set "PKG_MANAGER=choco"
	)
)

if "%ALLOW_INSTALL%"=="1" (
	if "%PKG_MANAGER%"=="" (
		echo No supported package manager found.
		echo Please install winget or Chocolatey, then try again.
		exit /b 1
	)

	echo Using package manager: %PKG_MANAGER%
)

@REM DOes node exist
where node >nul 2>nul
if errorlevel 1 (
	if "%ALLOW_INSTALL%"=="1" (
		call :installNode
	) else (
		echo Node.js is required but is not installed.
		exit /b 1
	)
)

@REM DOes NPM exist, they sohuld both exist but you never know with people
where npm >nul 2>nul
if errorlevel 1 (
	echo npm is required but was not found after checking Node.js.
	echo Please reinstall Node.js and try again.
	exit /b 1
)

@REM Does git exist

where git >nul 2>nul
if errorlevel 1 (
	if "%ALLOW_INSTALL%"=="1" (
		call :installGit
	) else (
		echo Git is required but is not installed.
		exit /b 1
	)
)

@REM Does the PNPM exist
where pnpm >nul 2>nul
if errorlevel 1 (
	echo pnpm is not installed. Installing pnpm globally using npm...
	call npm install -g pnpm
	if errorlevel 1 (
		echo Failed to install pnpm.
		exit /b 1
	)
)

@REM Final steps, Vencord installation
if exist "Vencord" (
	echo Vencord folder already exists in this directory.
	exit /b 1
)

git clone https://github.com/PFearr/Vencord
if errorlevel 1 exit /b 1

cd Vencord
if errorlevel 1 exit /b 1

call pnpm install
if errorlevel 1 exit /b 1

call pnpm run build
if errorlevel 1 exit /b 1

call pnpm run inject
if errorlevel 1 exit /b 1

cd ..

@REM Do you want to delete the repository?
set /p ask="Do you want to delete the Vencord repository? (y/n): "
if /I "%ask%"=="y" (
	rmdir /s /q "Vencord"
	echo Vencord repository deleted.
) else (
	echo Vencord repository not deleted. All installed!
)

exit /b 0

@REM Helpers
:installNode
echo Node.js was not found. Installing Node.js...
if "%PKG_MANAGER%"=="winget" (
	winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
) else (
	choco install nodejs-lts -y
)
if errorlevel 1 (
	echo Failed to install Node.js.
	exit /b 1
)
exit /b 0

:installGit
echo Git was not found. Installing Git...
if "%PKG_MANAGER%"=="winget" (
	winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
) else (
	choco install git -y
)
if errorlevel 1 (
	echo Failed to install Git.
	exit /b 1
)
exit /b 0