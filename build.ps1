param(
    [switch]$DesktopTest,
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

Push-Location $PSScriptRoot
try {
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
} finally {
    Pop-Location
}
