# tunlite bootstrap (Windows) — irm <raw bootstrap.ps1> | iex
# Body wrapped in a function invoked on the LAST line, mirroring bootstrap.sh's
# main(): a truncated `irm | iex` pipe then defines an incomplete Main and never
# reaches the call, so a partial script can't run.
$ErrorActionPreference = 'Stop'
function Main {
  $repo = 'https://github.com/yuanyuanzijin/tunlite'
  $ref  = if ($env:TUNLITE_REF) { $env:TUNLITE_REF } else { 'master' }
  $url  = if ($env:TUNLITE_ARCHIVE_URL) { $env:TUNLITE_ARCHIVE_URL } else { "$repo/archive/$ref.tar.gz" }
  $tmp  = Join-Path $env:TEMP ("tunlite-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $tgz = Join-Path $tmp 'src.tar.gz'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tgz
    tar xz --strip-components=1 -C $tmp -f $tgz
    node (Join-Path $tmp 'bin\tunlite.js') install @args
  } finally { Remove-Item -Recurse -Force $tmp }
}
Main @args
