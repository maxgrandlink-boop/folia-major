# 在实机上跑 W3 三项验收。默认读 D:\okchang-test 里的作品；没有就用程序生成的三轨。
param(
    [string]$Root = 'D:\okchang-test',
    [string]$Engine = '',
    [string]$Tests = '',
    [int]$WatchSec = 0
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..\..')

if (-not $Engine) {
    if ($env:OK_ENGINE_PATH) { $Engine = $env:OK_ENGINE_PATH }
    elseif (Test-Path (Join-Path $repo 'build\ok-engine\ok-engine.exe')) { $Engine = Join-Path $repo 'build\ok-engine\ok-engine.exe' }
    elseif (Test-Path (Join-Path $repo 'build\ok-engine-cmake\Release\ok-engine.exe')) { $Engine = Join-Path $repo 'build\ok-engine-cmake\Release\ok-engine.exe' }
}
if (-not $Tests) {
    if (Test-Path (Join-Path $repo 'build\ok-engine-cmake\Release\ok-engine-tests.exe')) { $Tests = Join-Path $repo 'build\ok-engine-cmake\Release\ok-engine-tests.exe' }
    elseif (Test-Path (Join-Path $repo 'native\ok-engine\build\ok-engine-tests.exe')) { $Tests = Join-Path $repo 'native\ok-engine\build\ok-engine-tests.exe' }
}
if (-not $Engine -or -not (Test-Path $Engine)) {
    Write-Error "ok-engine.exe not found. Pass -Engine or set OK_ENGINE_PATH."
}

Write-Host "[ok-engine] engine $Engine"
Write-Host "[ok-engine] root $Root"
if ($Tests -and (Test-Path $Tests)) {
    Write-Host '[ok-engine] generated-signal seek test'
    & $Tests
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Write-Host '[ok-engine] test binary missing; seek self-test will generate signals if the root has no tracks'
}

Write-Host '[ok-engine] seek'
& $Engine --self-test seek --root $Root
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[ok-engine] memory'
& $Engine --self-test memory --root $Root
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[ok-engine] device'
& $Engine --self-test device --root $Root --watch $WatchSec
exit $LASTEXITCODE
