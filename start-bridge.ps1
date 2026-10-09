$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'service.mjs') start
exit $LASTEXITCODE
