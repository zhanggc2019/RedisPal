param(
    [switch]$DesktopTest,
    [switch]$Installer,
    [ValidatePattern('^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$')]
    [string]$AppVersion = '0.0.1',
    [ValidatePattern('^https://[^\s"''\x60]+$')]
    [string]$UpdateManifestURL,
    [ValidatePattern('^[A-Za-z0-9+/]{43}=$')]
    [string]$UpdatePublicKey
)

$ErrorActionPreference = 'Stop'

# Stop after a native tool fails so an outdated executable cannot appear successful.
function Assert-LastExitCode([string]$Action) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Action failed with exit code $LASTEXITCODE."
    }
}

# Package the same Windows executable with NSIS and the runtime from pinned Wails.
function New-RedisPalInstaller([string]$Executable, [string]$Version) {
    $compiler = (Get-Command makensis.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (!$compiler) {
        $compiler = @("${env:ProgramFiles(x86)}\NSIS\makensis.exe", "$env:ProgramFiles\NSIS\makensis.exe") |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    if (!$compiler) {
        throw 'Install NSIS and make makensis.exe available to build the Windows installer.'
    }

    $wailsDir = go list -m -f '{{.Dir}}' github.com/wailsapp/wails/v3
    Assert-LastExitCode 'Locate Wails module'
    $bootstrapper = Join-Path $wailsDir 'internal/commands/webview2/MicrosoftEdgeWebview2Setup.exe'
    if (!(Test-Path -LiteralPath $bootstrapper -PathType Leaf)) {
        throw 'The pinned Wails module is missing its WebView2 bootstrapper.'
    }

    $binaryPath = (Resolve-Path -LiteralPath $Executable).Path
    $setupPath = Join-Path $PSScriptRoot 'bin/RedisPal-windows-x64-setup.exe'
    $fileVersion = ($Version -split '[-+]', 2)[0] + '.0'
    $script = Join-Path $PSScriptRoot 'build/windows/installer.nsi'
    & $compiler /V3 /INPUTCHARSET UTF8 "/DAPP_EXE=$binaryPath" "/DINSTALLER_PATH=$setupPath" `
        "/DAPP_VERSION=$Version" "/DAPP_FILE_VERSION=$fileVersion" "/DWEBVIEW2_BOOTSTRAPPER=$bootstrapper" $script
    Assert-LastExitCode 'NSIS build'
    Get-Item -LiteralPath $setupPath
}

Push-Location $PSScriptRoot
try {
    if ($Installer) {
        if ($DesktopTest) {
            throw '-Installer and -DesktopTest produce different application builds.'
        }
        $target = (go env GOOS GOARCH) -join '/'
        Assert-LastExitCode 'Check installer target'
        if ($target -ne 'windows/amd64') {
            throw 'The installer requires a windows/amd64 build.'
        }
    }
    npm.cmd --prefix frontend ci
    Assert-LastExitCode 'npm ci'
    npm.cmd --prefix frontend run build
    Assert-LastExitCode 'Vite build'

    New-Item -ItemType Directory -Path bin -Force | Out-Null
    $tags = 'production'
    $executable = 'bin/RedisPal.exe'
    if ($DesktopTest) {
        $tags = 'production,ardm_desktop_test'
        $executable = 'bin/RedisPal-test.exe'
    }
    if ([bool]$UpdateManifestURL -ne [bool]$UpdatePublicKey) {
        throw 'Provide both UpdateManifestURL and UpdatePublicKey.'
    }
    $flags = "-H windowsgui -s -w -X=main.appVersion=$AppVersion"
    if ($UpdateManifestURL) {
        $flags += " -X=main.updateManifestURL=$UpdateManifestURL -X=main.updatePublicKey=$UpdatePublicKey"
    }
    go build -trimpath -tags $tags -ldflags $flags -o $executable .
    Assert-LastExitCode 'Wails build'
    Get-Item -LiteralPath $executable
    if ($Installer) {
        New-RedisPalInstaller $executable $AppVersion
    }
} finally {
    Pop-Location
}
