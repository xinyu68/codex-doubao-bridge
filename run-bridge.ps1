$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'service.mjs') run
exit $LASTEXITCODE
