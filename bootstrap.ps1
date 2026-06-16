# tunlite bootstrap (Windows) — irm <raw bootstrap.ps1> | iex
# Body wrapped in a function invoked on the LAST line, mirroring bootstrap.sh's
# main(): a truncated `irm | iex` pipe then defines an incomplete Main and never
# reaches the call, so a partial script can't run.
$ErrorActionPreference = 'Stop'
function Main {
  $repo = 'https://github.com/yuanyuanzijin/tunlite'
  $ref  = if ($env:TUNLITE_REF) { $env:TUNLITE_REF } else { 'master' }
  $url  = if ($env:TUNLITE_ARCHIVE_URL) { $env:TUNLITE_ARCHIVE_URL } else { "$repo/archive/$ref.tar.gz" }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'tunlite: Node.js >= 18 is required' }
  node -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)"
  if ($LASTEXITCODE -ne 0) { throw "tunlite: Node.js >= 18 is required (found $(node -v))" }
  # Windows has no /dev/tty, so install can't prompt over the `irm | iex` pipe —
  # default to registering autostart (the core of "install"). The agent skill and
  # shell completion stay opt-in: add --skill user / --completion to include them.
  $a = @($args)
  if (-not ($a -contains '--service' -or $a -contains '--no-service')) { $a = @('--service') + $a }
  $tmp  = Join-Path $env:TEMP ("tunlite-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $tgz = Join-Path $tmp 'src.tar.gz'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tgz
    tar xz --strip-components=1 -C $tmp -f $tgz
    node (Join-Path $tmp 'bin\tunlite.js') install @a
  } finally { Remove-Item -Recurse -Force $tmp }
}
Main @args
