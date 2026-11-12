<#
swarm-os -- guided installer for Windows (PowerShell 5.1+ or PowerShell 7).

The Windows twin of install.sh. Same two modes, chosen by what it finds:

  WIZARD -- no `.env` yet, or -Reconfigure. Walks through the steps of
            docs/deploy/install.en.md: host prerequisites (Docker Desktop,
            Claude Code CLI + login), project paths, image + registry login,
            remote access, notifications, update detection. Writes `.env`, then
            deploys.
  DEPLOY -- `.env` is already there: pull, `compose up -d`, wait for /health,
            print the token. Safe to re-run; this is also the update path.

What differs from install.sh, and why:
  * Docker means Docker Desktop (WSL 2 backend, Linux containers). There is
    no uid to fix: Desktop bind mounts are writable by the container as-is.
  * The agent transport is always `local` (agents run inside the container,
    claude only). The `ssh` transport runs every agent as `bash -lc ...` on the
    host, which needs a POSIX host: for it -- and for codex / gemini / opencode
    and one-click updates -- run ./install.sh from a WSL 2 distribution instead.
  * Paths in `.env` are written as C:/Users/... (forward slashes), and the file
    is written as UTF-8 without BOM, LF line endings.

Rules it holds itself to (same as install.sh):
  * nothing is installed or written without a confirmation naming the exact
    command -- and every such step can be declined, leaving you the manual one;
  * an existing `.env` is backed up (`.env.backup-<timestamp>`) before being
    replaced, never edited in place.

Usage (from the kit directory):
  powershell -ExecutionPolicy Bypass -File .\install.ps1               wizard, then deploy
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Reconfigure  re-run the wizard
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Yes          no questions, deploy .env
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -EnvFile P    use env file P
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Help

On a bare host (no kit yet), one line in PowerShell -- the script fetches the
kit into ~\swarm-os (or -Dir / $env:SWARM_OS_DIR) and carries on from there:
  irm https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/install.ps1 | iex
#>
[CmdletBinding()]
param(
  [switch]$Reconfigure,
  [switch]$Yes,
  [string]$EnvFile = '',
  [string]$Dir = '',
  [string]$Ref = '',
  [string]$Token = '',
  [switch]$Help
)

# NOT 'Stop': under Windows PowerShell 5.1 a native command writing to stderr
# becomes a terminating error with 'Stop', and docker writes progress there.
# Every call that must not fail is checked explicitly (exit code / Die).
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is 10x slower with the bar
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$script:Repo         = if ($env:SWARM_OS_REPO) { $env:SWARM_OS_REPO } else { 'Nyyyxius/swarm-os' }
$script:ComposeDist  = 'examples/docker-compose.dist.yml'
$script:ComposeSsh   = 'examples/docker-compose.ssh.yml'
$script:DefaultImage = 'ghcr.io/nyyyxius/swarm-os:latest'
$script:LocalImage   = 'swarm-os:local'
$script:ReleasesApi  = "https://api.github.com/repos/$($script:Repo)/releases/latest"

# The kit -- the same list bootstrap.sh fetches.
$script:Kit = @(
  'install.sh', 'install.ps1', 'bootstrap.sh', 'README.md',
  'docs/plugins.md', 'docs/builtin-features.md', 'docs/providers.md', 'docs/comparatif-hermes-agent.md',
  '.env.example', 'LICENSE',
  'examples/.env.example', 'examples/docker-compose.dist.yml', 'examples/docker-compose.ssh.yml',
  'examples/docker-compose.multi.yml',
  'docs/deploy/README.md', 'docs/deploy/install.en.md', 'docs/deploy/install.fr.md',
  'docs/deploy/usage.en.md', 'docs/deploy/usage.fr.md'
)

$script:Interactive = $false
try { $script:Interactive = (-not [Console]::IsInputRedirected) -and (-not [Console]::IsOutputRedirected) } catch { }
if ($Yes) { $script:Interactive = $false }

# == Presentation =============================================================
$script:UseColor = -not $env:NO_COLOR

function W([string]$Text, [string]$Color = '', [switch]$NoNewline) {
  if ($script:UseColor -and $Color) { Write-Host $Text -ForegroundColor $Color -NoNewline:$NoNewline }
  else { Write-Host $Text -NoNewline:$NoNewline }
}
function Say([string]$m)  { W '==> ' 'Cyan' -NoNewline; W $m }
function Ok([string]$m)   { W '  ok ' 'Green' -NoNewline; W $m }
function Warn([string]$m) { W ' [!] ' 'Yellow' -NoNewline; W $m }
function Note([string]$m) { W "     $m" 'DarkGray' }

# Die never calls `exit`: under `irm | iex` that would close the operator's
# PowerShell window. It throws a marker the entry point turns into exit code 1.
$script:DieMarker  = '__swarm_os_die__'
$script:DoneMarker = '__swarm_os_done__'
function Die([string]$m) { W ' [x] ' 'Red' -NoNewline; W $m; throw $script:DieMarker }
function Done { throw $script:DoneMarker }

$script:StepN = 0
$script:StepTotal = 8
function Step([string]$Title, [string]$Hint = '') {
  $script:StepN++
  W ''
  W '+- ' 'Cyan' -NoNewline; W "[$($script:StepN)/$($script:StepTotal)] $Title" 'White'
  if ($Hint) { W '|  ' 'Cyan' -NoNewline; W $Hint 'DarkGray' }
  W '+' 'Cyan'
}

function Banner {
  W ''
  W '  +------------------------------------------------+' 'Cyan'
  W '  |   swarm-os -- guided install (Windows)         |' 'Cyan'
  W '  |   teams of autonomous coding agents, one host  |' 'Cyan'
  W '  +------------------------------------------------+' 'Cyan'
  W ''
}

# == Prompts ==================================================================
# All of them degrade to their default when there is no console or -Yes was
# given, so the same code path serves an operator and a CI run.

function Ask([string]$Question, [string]$Default = '') {
  if (-not $script:Interactive) { return $Default }
  W '  ? ' 'Cyan' -NoNewline
  if ($Default) { W "$Question " -NoNewline; W "[$Default] " 'DarkGray' -NoNewline }
  else { W "${Question}: " -NoNewline }
  $a = Read-Host
  if ([string]::IsNullOrEmpty($a)) { return $Default }
  return $a.Trim()
}

function Ask-Secret([string]$Question) {
  if (-not $script:Interactive) { return '' }
  W '  ? ' 'Cyan' -NoNewline; W "$Question " -NoNewline; W '(hidden, empty to skip): ' 'DarkGray' -NoNewline
  $ss = Read-Host -AsSecureString
  if (-not $ss -or $ss.Length -eq 0) { return '' }
  return (New-Object System.Net.NetworkCredential('', $ss)).Password
}

function Ask-YN([string]$Question, [string]$Default = 'y') {
  $hint = if ($Default -eq 'n') { '[y/N]' } else { '[Y/n]' }
  if (-not $script:Interactive) { return ($Default -eq 'y') }
  while ($true) {
    W '  ? ' 'Cyan' -NoNewline; W "$Question " -NoNewline; W "$hint " 'DarkGray' -NoNewline
    $a = Read-Host
    if ([string]::IsNullOrEmpty($a)) { $a = $Default }
    switch ($a.Trim().ToLower()) {
      { $_ -in 'y', 'yes', 'o', 'oui' } { return $true }
      { $_ -in 'n', 'no', 'non' }       { return $false }
      default { W '     answer y or n' }
    }
  }
}

# Choose <default index, 1-based> @( @('value','label','hint'), ... )
function Choose([int]$Default, [object[]]$Options) {
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $o = $Options[$i]
    if (($i + 1) -eq $Default) {
      W "     $($i + 1)) " 'White' -NoNewline; W $o[1] 'White' -NoNewline; W ' (default)' 'DarkGray'
    } else {
      W "     $($i + 1)) " 'White' -NoNewline; W $o[1]
    }
    if ($o.Count -gt 2 -and $o[2]) { W "        $($o[2])" 'DarkGray' }
  }
  if (-not $script:Interactive) { return $Options[$Default - 1][0] }
  while ($true) {
    W '  ? ' 'Cyan' -NoNewline; W 'choice ' -NoNewline; W "[$Default] " 'DarkGray' -NoNewline
    $a = Read-Host
    if ([string]::IsNullOrEmpty($a)) { $a = "$Default" }
    $n = 0
    if (-not [int]::TryParse($a.Trim(), [ref]$n)) { W '     enter a number'; continue }
    if ($n -ge 1 -and $n -le $Options.Count) { return $Options[$n - 1][0] }
    W '     out of range'
  }
}

# Prints the command, asks, runs it. $Action is the scriptblock that does it.
function Run-Confirmed([string]$Why, [string]$Shown, [scriptblock]$Action) {
  Note $Why
  W "     > $Shown" 'White'
  if (Ask-YN 'Run it?' 'y') {
    # Out-Host: the command's output belongs on the screen, not in this
    # function's return value.
    $global:LASTEXITCODE = 0
    & $Action | Out-Host
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Warn 'that command failed.'; return $false }
    return $true
  }
  return $false
}

# == Small host helpers =======================================================
function Have([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Runs a native command, discards its output, returns $true on exit code 0.
function Test-Native([scriptblock]$Cmd) {
  & $Cmd *> $null
  return ($LASTEXITCODE -eq 0)
}

function Write-TextNoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# ~, ${HOME}, $HOME, %VAR% expanded; made absolute; written with forward slashes
# (Docker Desktop and compose both accept C:/Users/...; backslashes in a .env
# are an escaping trap).
function Expand-UserPath([string]$p) {
  if (-not $p) { return $p }
  $p = $p.Trim()
  if ($p -eq '~') { $p = $HOME }
  elseif ($p.StartsWith('~/') -or $p.StartsWith('~\')) { $p = Join-Path $HOME $p.Substring(2) }
  $p = $p.Replace('${HOME}', $HOME).Replace('$HOME', $HOME).Replace('${USERPROFILE}', $HOME)
  $p = [Environment]::ExpandEnvironmentVariables($p)
  $p = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p)
  return $p.Replace('\', '/')
}

function Get-Slug([string]$s) {
  $s = ($s.ToLower() -replace '[^a-z0-9-]', '-') -replace '-+', '-'
  return $s.Trim('-')
}

function Test-PortInUse([int]$Port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $t = $c.ConnectAsync('127.0.0.1', $Port)
    return ($t.Wait(400) -and $c.Connected)
  } catch { return $false } finally { $c.Close() }
}

function Get-FreePort([int]$From) {
  $p = $From
  while ((Test-PortInUse $p) -and $p -lt 65535) { $p++ }
  return $p
}

# A reference with a path segment can be pulled; a bare `name:tag` is a locally
# built image -- the same rule the update surface applies.
function Test-RegistryImage([string]$Ref) { return $Ref.Contains('/') }

# HTTP status of a GET, 0 when unreachable. PS 5.1 and 7 throw differently.
function Get-HttpStatus([string]$Url, [hashtable]$Headers) {
  try {
    $r = Invoke-WebRequest -Uri $Url -Headers $Headers -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
    return [int]$r.StatusCode
  } catch {
    if ($_.Exception.Response) { try { return [int]$_.Exception.Response.StatusCode } catch { } }
    return 0
  }
}

# The env file as a hashtable (KEY=VALUE, comments and blanks skipped).
function Read-EnvFile([string]$Path) {
  $h = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $h }
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    $l = $line.Trim()
    if (-not $l -or $l.StartsWith('#')) { continue }
    $i = $l.IndexOf('=')
    if ($i -lt 1) { continue }
    $k = $l.Substring(0, $i).Trim()
    if ($k.StartsWith('export ')) { $k = $k.Substring(7).Trim() }
    $v = $l.Substring($i + 1).Trim()
    if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    $h[$k] = $v
  }
  return $h
}

# The configuration being built, keyed by the .env variable names.
$script:C = @{}
function Cfg([string]$Key, [string]$Default = '') {
  if ($script:C.ContainsKey($Key) -and $script:C[$Key]) { return [string]$script:C[$Key] }
  return $Default
}

# == Kit (bootstrap) ==========================================================
# install.ps1 is one file of a kit: the compose files must sit beside it. When
# they do not -- `irm | iex`, or the script downloaded on its own -- fetch the
# kit the way bootstrap.sh does and carry on from there.
function Get-Kit([string]$Target, [string]$GitRef, [string]$Pat) {
  Say "Fetching the kit for $($script:Repo)@$GitRef into $Target"
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  $failed = @(); $fetched = 0
  foreach ($path in $script:Kit) {
    $dest = Join-Path $Target ($path.Replace('/', '\'))
    New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
    if ($Pat) {
      $url = "https://api.github.com/repos/$($script:Repo)/contents/${path}?ref=$GitRef"
      $hdr = @{ Authorization = "Bearer $Pat"; Accept = 'application/vnd.github.raw'; 'X-GitHub-Api-Version' = '2022-11-28' }
    } else {
      $url = "https://raw.githubusercontent.com/$($script:Repo)/$GitRef/$path"
      $hdr = @{}
    }
    $code = 0
    try {
      $r = Invoke-WebRequest -Uri $url -Headers $hdr -UseBasicParsing -OutFile "$dest.part" -PassThru -TimeoutSec 30 -ErrorAction Stop
      $code = [int]$r.StatusCode
    } catch {
      if ($_.Exception.Response) { try { $code = [int]$_.Exception.Response.StatusCode } catch { } }
    }
    if ($code -eq 200 -and (Test-Path -LiteralPath "$dest.part") -and (New-Object System.IO.FileInfo("$dest.part")).Length -gt 0) {
      Move-Item -Force "$dest.part" $dest
      Note $path
      $fetched++
    } else {
      Remove-Item -Force "$dest.part" -ErrorAction SilentlyContinue
      $failed += "$path($code)"
    }
  }
  if ($failed.Count -gt 0) {
    Warn "could not fetch: $($failed -join ' ')"
    if ($fetched -gt 0) {
      Note "GitHub answers fine -- $fetched other files came down from $($script:Repo)@$GitRef"
      Die "those paths do not exist at $GitRef. Pick a ref that has them (-Ref master), or ask the maintainer for a newer tag."
    }
    $all = $failed -join ' '
    if ($all -match '\((401|403)\)') { Die "GitHub refused the token. It needs read access to $($script:Repo) -- or drop it: the public repo needs none." }
    if ($all -match '\(404\)') { Die "GitHub answered 404: -Ref $GitRef does not exist, or $($script:Repo) is a private fork the token cannot see." }
    if ($all -match '\(0\)') { Die 'could not reach GitHub -- check outbound network/DNS.' }
    Die 'kit incomplete -- nothing was started.'
  }
  Ok "kit ready in $Target"
}

# =============================================================================
# STEP 1 -- host prerequisites
# =============================================================================
$script:ComposeExe  = 'docker'
$script:ComposeBase = @('compose')

function Get-DockerDesktopExe {
  $c = @("$env:ProgramFiles\Docker\Docker\Docker Desktop.exe", "$env:LOCALAPPDATA\Docker\Docker Desktop.exe")
  foreach ($p in $c) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
  return $null
}

function Check-Docker {
  if (-not (Have 'docker')) {
    Warn 'Docker is not installed.'
    if ($script:Interactive -and (Have 'winget')) {
      $ok = Run-Confirmed 'install Docker Desktop (WSL 2 backend) with winget -- it may ask for elevation and a reboot' `
        'winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements' `
        { winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements }
      if ($ok) {
        Warn 'Docker Desktop is installed. Start it once, finish its first-run setup (WSL 2, Linux containers),'
        Note 'reboot if it asks to, then open a NEW PowerShell window and re-run this installer.'
        Done
      }
    }
    Die 'Docker Desktop is required. https://docs.docker.com/desktop/setup/install/windows-install/'
  }

  if (-not (Test-Native { docker info })) {
    Warn 'The Docker daemon is not reachable (is Docker Desktop running?).'
    $exe = Get-DockerDesktopExe
    if ($script:Interactive -and $exe) {
      if (Run-Confirmed 'start Docker Desktop and wait for its engine' "Start-Process `"$exe`"" { Start-Process -FilePath $exe; $global:LASTEXITCODE = 0 }) {
        Say 'Waiting for the Docker engine (up to 3 minutes) ...'
        for ($i = 0; $i -lt 90; $i++) {
          if (Test-Native { docker info }) { break }
          Start-Sleep -Seconds 2
        }
      }
    }
    if (-not (Test-Native { docker info })) { Die 'Docker daemon not reachable. Start Docker Desktop, then re-run.' }
  }

  # The image is linux/amd64|arm64: Desktop in Windows-containers mode cannot run it.
  $os = (& docker version --format '{{.Server.Os}}' 2>$null | Out-String).Trim()
  if ($os -and $os -ne 'linux') {
    Die "Docker Desktop is in $os-containers mode. Right-click its tray icon > 'Switch to Linux containers', then re-run."
  }

  if (Test-Native { docker compose version }) {
    $script:ComposeExe = 'docker'; $script:ComposeBase = @('compose')
  } elseif (Have 'docker-compose') {
    $script:ComposeExe = 'docker-compose'; $script:ComposeBase = @()
    Warn 'Using the v1 docker-compose binary. v2 (`docker compose`) is what this kit is tested on.'
  } else {
    Die 'Docker Compose v2 not found -- update Docker Desktop.'
  }
  $ver = (& docker version --format '{{.Server.Version}}' 2>$null | Out-String).Trim()
  if (-not $ver) { $ver = '?' }
  Ok "Docker $ver + Compose available"
}

# The installer drops claude.exe in ~\.local\bin, which this already-running
# session may not have on PATH yet.
function Refresh-ClaudePath {
  if (Have 'claude') { return $true }
  $bin = Join-Path $HOME '.local\bin'
  if ((Test-Path -LiteralPath $bin) -and -not (($env:PATH -split ';') -contains $bin)) { $env:PATH = "$bin;$env:PATH" }
  return (Have 'claude')
}

# The one hard prerequisite: an authenticated Claude Code CLI ON THE HOST.
# swarm-os ships no API key -- every agent launches the CLI and inherits these
# credentials. Without them a spawned session hangs on the first-run theme
# picker, which looks like a swarm-os bug and is not one.
function Check-Claude {
  $claudeDir  = Expand-UserPath (Cfg 'CLAUDE_DIR' (Join-Path $HOME '.claude'))
  $claudeJson = Expand-UserPath (Cfg 'CLAUDE_JSON' (Join-Path $HOME '.claude.json'))

  if (-not (Refresh-ClaudePath)) {
    Warn 'The Claude Code CLI is not on PATH.'
    # The NATIVE installer -- not the npm package, which only wraps the same
    # binary and needs Node.js for nothing. Run in a child process so its own
    # `exit` or a failure cannot take this installer down with it.
    $ps = (Get-Process -Id $PID).Path
    Run-Confirmed 'install the native Claude Code CLI (lands in ~\.local\bin, keeps itself up to date)' `
      'irm https://claude.ai/install.ps1 | iex' `
      { & $ps -NoProfile -ExecutionPolicy Bypass -Command 'irm https://claude.ai/install.ps1 | iex' } | Out-Null
    if (-not (Refresh-ClaudePath)) { Note 'installed in ~\.local\bin -- add it to your user PATH if `claude` is still not found' }
  }
  if (Have 'claude') {
    $v = (& claude --version 2>$null | Select-Object -First 1 | Out-String).Trim()
    Ok "claude CLI: $v"
  }

  $cred = "$claudeDir/.credentials.json"
  if (-not (Test-Path -LiteralPath $cred)) {
    Warn "No Claude Code credentials at $cred"
    Note 'agents cannot start without them -- this is the one blocking prerequisite'
    if ($script:Interactive -and (Have 'claude')) {
      Note 'Launching `claude` so you can complete the OAuth login.'
      Note 'Finish the login, then leave the CLI (/exit) to come back here.'
      if (Ask-YN 'Run `claude` now?' 'y') { & claude }
    }
  }
  if (Test-Path -LiteralPath $cred) { Ok "Claude credentials found at $claudeDir" }
  else { Warn 'Still no credentials. The install continues, but no agent will start until you run `claude` and log in.' }

  # Bind-mounting a path that does not exist makes Docker create a DIRECTORY at
  # that path; the container then reads a directory where it expects
  # ~/.claude.json and the first spawn stalls on the theme picker.
  if (-not (Test-Path -LiteralPath $claudeJson -PathType Leaf)) {
    Warn "$claudeJson does not exist -- Docker would create a directory there."
    if (Ask-YN 'Create it as an empty JSON file?' 'y') {
      Write-TextNoBom $claudeJson "{}`n"
      Ok "created $claudeJson"
    }
  }
  $script:C['CLAUDE_DIR']  = $claudeDir
  $script:C['CLAUDE_JSON'] = $claudeJson
}

function Wiz-Prereqs {
  Step 'Host prerequisites' 'Docker Desktop, Compose, and the Claude Code login every agent inherits'
  Check-Docker
  Check-Claude
}

# =============================================================================
# STEP 2 -- project identity and host paths
# =============================================================================
function Wiz-Identity {
  Step 'Project' 'one swarm-os instance drives exactly one project'

  $name = Ask 'Project name (shown in the UI, logs and Discord)' (Cfg 'SWARM_OS_PROJECT_NAME' 'my-project')
  $script:C['SWARM_OS_PROJECT_NAME'] = $name
  $slug = Get-Slug $name
  if (-not $slug) { $slug = 'swarm-os' }

  # Workspace -- the tree the agents actually edit, mounted read-write.
  $ws = Expand-UserPath (Ask 'Workspace directory (the project the agents work in)' (Cfg 'WORKSPACE_PATH' ((Join-Path $HOME "dev\$slug").Replace('\', '/'))))
  if (-not (Test-Path -LiteralPath $ws -PathType Container)) {
    if (Ask-YN "$ws does not exist. Create it?" 'y') {
      New-Item -ItemType Directory -Force -Path $ws | Out-Null
      if (-not (Test-Path -LiteralPath $ws)) { Die "could not create $ws" }
      Ok "created $ws"
    } else {
      Die 'the workspace directory must exist before the container mounts it.'
    }
  }
  # A brand-new workspace is the moment to bring the code in.
  if ($script:Interactive -and -not (Get-ChildItem -LiteralPath $ws -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    $repoUrl = Ask 'Workspace is empty -- git URL to clone into it (empty to skip)' ''
    if ($repoUrl) {
      if (Have 'git') {
        & git clone $repoUrl $ws
        if ($LASTEXITCODE -eq 0) { Ok "cloned into $ws" } else { Warn 'clone failed -- continuing with an empty workspace.' }
      } else { Warn 'git is not installed -- skipping the clone (winget install -e --id Git.Git).' }
    }
  }
  $script:C['WORKSPACE_PATH'] = $ws

  # Data -- SQLite, tokens, logs, backups, the per-session claude runtime.
  # No ownership dance here: Docker Desktop bind mounts are writable by the
  # container's uid as they are.
  $data = Expand-UserPath (Ask 'State directory (SQLite db, tokens, logs, backups)' (Cfg 'DATA_PATH' ((Join-Path $HOME ".swarm-os\$slug").Replace('\', '/'))))
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  if (-not (Test-Path -LiteralPath $data)) { Die "could not create $data" }
  $script:C['DATA_PATH'] = $data

  $cname = Ask 'Container name (unique per instance on this host)' (Cfg 'SWARM_OS_CONTAINER_NAME' "swarm-os-$slug")
  $script:C['SWARM_OS_CONTAINER_NAME'] = $cname

  $port = Ask 'Host port for the web UI (bound to 127.0.0.1 only)' (Cfg 'SWARM_OS_PORT' '8787')
  $pn = 0
  if (-not [int]::TryParse($port, [ref]$pn)) { Die "not a port number: $port" }
  # Our own container holding the port on a re-run is not a conflict.
  $ours = (& docker ps --filter "name=^${cname}$" --format '{{.Names}}' 2>$null | Out-String).Trim()
  if ((Test-PortInUse $pn) -and $ours -ne $cname) {
    Warn "port $pn is already in use on this host."
    $port = Ask 'Pick another port' ([string](Get-FreePort ($pn + 1)))
  }
  $script:C['SWARM_OS_PORT'] = $port
}

# =============================================================================
# STEP 3 -- image
# =============================================================================
$script:ImageSource = 'registry'

function Wiz-Image {
  Step 'Image' 'a published image from GHCR, or one built here from this source tree'

  # Reconfiguring a locally-built deployment should not silently flip it back
  # to the registry on a blind enter.
  $cur = Cfg 'SWARM_OS_IMAGE' ''
  $def = 1
  if ($cur -and -not (Test-RegistryImage $cur)) { $def = 2 }
  $script:ImageSource = Choose $def @(
    @('registry', 'Pull the published image from GHCR', 'recommended'),
    @('local', 'Build it here from this repository', 'needs the full source tree (Dockerfile)')
  )

  if ($script:ImageSource -eq 'local') {
    if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot 'Dockerfile'))) { Die 'no Dockerfile here -- a local build needs the full source tree.' }
    $script:C['SWARM_OS_IMAGE'] = $script:LocalImage
    Note "the image will be built as $($script:LocalImage) at the deploy step"
    Note 'update it with git pull + .\install.ps1'
    return
  }

  $img = Ask 'Image reference' (Cfg 'SWARM_OS_IMAGE' $script:DefaultImage)
  $script:C['SWARM_OS_IMAGE'] = $img

  # A bare `name:tag` has no registry behind it: answer from the local store.
  if (-not (Test-RegistryImage $img)) {
    Warn "$img has no registry path -- swarm-os will treat it as a local build."
    if (Test-Native { docker image inspect $img }) { Ok "$img found in the local image store" }
    else {
      Warn "No image named $img here, and the reference has no registry to pull it from."
      Note 'give a full reference (ghcr.io/.../swarm-os:tag), or pick the local build above'
    }
    return
  }

  # Probe the pull now rather than at deploy: a private package failing to pull
  # is a login problem, and the login is a question, not an error message.
  Say "Checking access to $img ..."
  if (Test-Native { docker pull $img }) { Ok 'image pulled'; return }
  $registry = $img.Split('/')[0]
  Warn 'Could not pull it. The GHCR package is private: it needs a `docker login` with a'
  Note 'GitHub PAT carrying the read:packages scope, on an account the maintainer has granted access.'
  if ($script:Interactive -and (Ask-YN "Log in to $registry now?" 'y')) {
    $ghUser = Ask 'GitHub username' $env:USERNAME
    $pat = Ask-Secret 'GitHub PAT (read:packages)'
    if ($pat) {
      $pat | & docker login $registry -u $ghUser --password-stdin
      if ($LASTEXITCODE -eq 0) { Ok "logged in to $registry" } else { Warn 'docker login failed.' }
      $pat = $null
      if (Test-Native { docker pull $img }) { Ok 'image pulled' }
      else { Warn "still cannot pull $img -- the deploy step will try again." }
    }
  }
}

# =============================================================================
# STEP 4 -- agent transport (informational on Windows)
# =============================================================================
function Wiz-Transport {
  Step 'Agent transport' 'where the agent CLI processes actually run'
  # The ssh transport runs each agent as `bash -lc '...'` on the host and
  # translates container paths into POSIX host paths: neither exists on a
  # Windows host. So: local, and say what the alternative is.
  $script:C['SWARM_OS_AGENT_TRANSPORT'] = 'local'
  $script:C['SWARM_OS_DEFAULT_PROVIDER'] = 'claude'
  Ok 'local -- agents run inside the container, on the image''s own claude CLI'
  Note 'codex / gemini / opencode will report themselves unavailable -- correct, not a misconfiguration'
  Note 'one-click updates need the ssh transport: update with .\install.ps1 instead'
  Note 'want the ssh transport (all four providers, one-click updates)? run ./install.sh'
  Note 'from a WSL 2 distribution, with Docker Desktop''s WSL integration enabled for it'
}

# =============================================================================
# STEP 5 -- remote access
# =============================================================================
function Get-TailscaleExe {
  if (Have 'tailscale') { return 'tailscale' }
  $p = "$env:ProgramFiles\Tailscale\tailscale.exe"
  if (Test-Path -LiteralPath $p) { return $p }
  return $null
}

function Wiz-Access {
  Step 'Remote access' 'the UI listens on 127.0.0.1 only, with no TLS in the container'
  $port = Cfg 'SWARM_OS_PORT' '8787'

  $m = Choose 1 @(
    @('loopback', 'Localhost only (or an SSH tunnel)', "safest -- http://127.0.0.1:$port on this machine"),
    @('tailscale', 'Tailscale (HTTPS on your tailnet)', 'recommended for phone access -- no public port'),
    @('proxy', 'Reverse proxy on a public domain', 'you run Caddy/nginx and own the TLS + the abuse')
  )

  switch ($m) {
    'loopback' {
      Note 'Discord deep-links stay off unless you set SWARM_OS_PUBLIC_URL later'
    }
    'tailscale' {
      $ts = Get-TailscaleExe
      if (-not $ts -and (Have 'winget')) {
        Warn 'tailscale is not installed.'
        Run-Confirmed 'install Tailscale with winget' 'winget install -e --id tailscale.tailscale' `
          { winget install -e --id tailscale.tailscale --accept-package-agreements --accept-source-agreements } | Out-Null
        $ts = Get-TailscaleExe
      }
      if ($ts) {
        if (-not (Test-Native { & $ts status })) {
          Run-Confirmed 'join this host to your tailnet (opens a login page)' 'tailscale up' { & $ts up } | Out-Null
        }
        $dns = ''
        try { $dns = ((& $ts status --json 2>$null | Out-String) | ConvertFrom-Json).Self.DNSName } catch { }
        if ($dns) { $dns = $dns.TrimEnd('.') }
        if ($dns) {
          Ok "tailnet name: $dns"
          if (Ask-YN "Publish 127.0.0.1:$port on https://${dns}:$port with ``tailscale serve``?" 'y') {
            & $ts serve --bg "--https=$port" "http://127.0.0.1:$port"
            if ($LASTEXITCODE -ne 0) { Warn 'tailscale serve failed -- run it yourself (as administrator) once the container is up.' }
          }
          $script:C['SWARM_OS_PUBLIC_URL'] = "https://${dns}:$port"
        } else {
          $script:C['SWARM_OS_PUBLIC_URL'] = Ask 'Public URL of the UI (for Discord deep-links)' (Cfg 'SWARM_OS_PUBLIC_URL' '')
        }
      } else {
        Warn 'tailscale is not available -- install it from https://tailscale.com/download/windows and re-run.'
      }
    }
    'proxy' {
      Note 'the proxy MUST forward WebSockets -- the live terminal and the event stream ride on them'
      Note 'the VS Code editor is reverse-proxied by swarm-os itself under /ide, so one vhost is enough'
      $script:C['SWARM_OS_PUBLIC_URL'] = Ask 'Public URL the operator will use' (Cfg 'SWARM_OS_PUBLIC_URL' 'https://swarm.example.com')
    }
  }
}

# =============================================================================
# STEP 6 -- notifications and update detection
# =============================================================================
function Wiz-Notifications {
  Step 'Notifications & updates' 'both optional; both are just one variable'

  $script:C['SWARM_OS_DISCORD_WEBHOOK_URL'] = Ask 'Discord webhook URL for idle / team-ended notifications (empty = off)' (Cfg 'SWARM_OS_DISCORD_WEBHOOK_URL' '')

  Note 'Update detection reads the GitHub Releases of the public swarm-os repo.'
  Note 'Any read-only GitHub PAT does -- the read:packages one used by docker login too.'
  Note 'Empty is healthy: it simply means "never tell me about releases".'
  $pat = ''
  $known = Cfg 'SWARM_OS_GITHUB_TOKEN' ''
  if ($known -and (Ask-YN 'A GitHub token is already configured -- keep it for update detection?' 'y')) { $pat = $known }
  if (-not $pat) { $pat = Ask-Secret 'GitHub PAT for update detection' }
  if ($pat) {
    $code = Get-HttpStatus $script:ReleasesApi @{ Authorization = "Bearer $pat" }
    switch ($code) {
      200 { Ok 'token can read the releases (latest release visible)' }
      404 { Warn 'the API answered 404 -- the token is valid but cannot see this repository (wrong scope or no access).' }
      { $_ -in 401, 403 } { Warn "the API refused the token (HTTP $code). Update detection will stay on no_token." }
      default { Warn "could not reach api.github.com (HTTP $code) -- keeping the token anyway." }
    }
  }
  $script:C['SWARM_OS_GITHUB_TOKEN'] = $pat
}

# =============================================================================
# STEP 7 -- advanced (skippable)
# =============================================================================
function Wiz-Advanced {
  Step 'Advanced settings' 'sensible defaults are already picked -- skip unless you need to tune'

  $defaults = [ordered]@{
    SWARM_OS_DEFAULT_MODEL = ''; SWARM_OS_DEFAULT_EFFORT = 'xhigh'
    SWARM_OS_MAX_ORCHESTRATORS = '10'; SWARM_OS_MAX_WORKERS_PER_ORCH = '20'
    SWARM_OS_LOG_LEVEL = 'info'; SWARM_OS_IDE_ENABLED = 'true'
  }
  if (-not (Ask-YN 'Review advanced settings?' 'n')) {
    foreach ($k in $defaults.Keys) { $script:C[$k] = Cfg $k $defaults[$k] }
    return
  }

  Note 'leave the model empty to inherit the default provider''s own current model (refreshed from models.dev)'
  $script:C['SWARM_OS_DEFAULT_MODEL'] = Ask 'Default model id (empty = the provider''s own)' (Cfg 'SWARM_OS_DEFAULT_MODEL' '')
  $script:C['SWARM_OS_DEFAULT_EFFORT'] = Choose 4 @(
    @('low', 'low', ''), @('medium', 'medium', ''), @('high', 'high', ''),
    @('xhigh', 'xhigh', 'the shipped default -- costly but thorough'), @('max', 'max', '')
  )
  $script:C['SWARM_OS_MAX_ORCHESTRATORS'] = Ask 'Max teams running at once' (Cfg 'SWARM_OS_MAX_ORCHESTRATORS' '10')
  $script:C['SWARM_OS_MAX_WORKERS_PER_ORCH'] = Ask 'Max workers per team' (Cfg 'SWARM_OS_MAX_WORKERS_PER_ORCH' '20')
  $script:C['SWARM_OS_LOG_LEVEL'] = Choose 3 @(
    @('trace', 'trace', ''), @('debug', 'debug', ''), @('info', 'info', 'the shipped default'),
    @('warn', 'warn', ''), @('error', 'error', '')
  )
  $script:C['SWARM_OS_IDE_ENABLED'] = if (Ask-YN 'Enable the built-in VS Code web editor (served under /ide on the same port)?' 'y') { 'true' } else { 'false' }
}

# =============================================================================
# STEP 8 -- review, then write .env
# =============================================================================
function Mask([string]$v) { if ($v) { 'set (hidden)' } else { '(not set)' } }
function Row([string]$k, [string]$v) {
  if (-not $v) { $v = '-' }
  W ('     {0,-24} ' -f $k) 'DarkGray' -NoNewline; W $v
}

function Wiz-Review {
  Step 'Review' "nothing has been written to $($script:EnvFilePath) yet"
  $img = Cfg 'SWARM_OS_IMAGE'
  if ($script:ImageSource -eq 'local') { $img = "$img (built here)" }
  Row 'project' (Cfg 'SWARM_OS_PROJECT_NAME')
  Row 'container' (Cfg 'SWARM_OS_CONTAINER_NAME')
  Row 'url' "http://127.0.0.1:$(Cfg 'SWARM_OS_PORT')"
  Row 'workspace' (Cfg 'WORKSPACE_PATH')
  Row 'state (/data)' (Cfg 'DATA_PATH')
  Row 'claude login' (Cfg 'CLAUDE_DIR')
  Row 'image' $img
  Row 'transport' 'local'
  Row 'default model' (Cfg 'SWARM_OS_DEFAULT_MODEL' '(provider default)')
  Row 'public url' (Cfg 'SWARM_OS_PUBLIC_URL' '(none -- loopback/tunnel)')
  Row 'discord webhook' (Mask (Cfg 'SWARM_OS_DISCORD_WEBHOOK_URL'))
  Row 'update detection' (Mask (Cfg 'SWARM_OS_GITHUB_TOKEN'))
  W ''
  if (-not (Ask-YN 'Write this configuration and deploy?' 'y')) { Die 'nothing was written.' }
}

function Write-Env {
  $path = $script:EnvFilePath
  if (Test-Path -LiteralPath $path) {
    $bak = "$path.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $path -Destination $bak
    Ok "previous config backed up to $(Split-Path $bak -Leaf)"
  }
  $L = New-Object System.Collections.Generic.List[string]
  function kv([string]$k, [string]$d = '') { $L.Add("$k=$(Cfg $k $d)") }
  $L.Add("# swarm-os -- deployment config, written by .\install.ps1 on $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm')) UTC.")
  $L.Add('# Re-run `.\install.ps1 -Reconfigure` to change any of it, or edit by hand and')
  $L.Add('# re-run `.\install.ps1`. Reference for every variable: docs/deploy/install.en.md')
  $L.Add('# (FR: install.fr.md) and .env.example.')
  $L.Add('#')
  $L.Add('# One KEY=VALUE per line, no quotes, no inline comments. Paths use forward slashes.')
  $L.Add('')
  $L.Add('# -- Image --')
  kv 'SWARM_OS_IMAGE'
  $L.Add('')
  $L.Add('# -- Identity --')
  kv 'SWARM_OS_PROJECT_NAME'; kv 'SWARM_OS_CONTAINER_NAME'
  $L.Add('')
  $L.Add('# -- Host paths --')
  kv 'WORKSPACE_PATH'; kv 'DATA_PATH'; kv 'CLAUDE_DIR'; kv 'CLAUDE_JSON'
  $L.Add('')
  $L.Add('# -- Ports (host loopback only -- never bind 0.0.0.0) --')
  kv 'SWARM_OS_PORT' '8787'
  $L.Add('')
  $L.Add('# -- Agent transport --')
  $L.Add('# local = agents run inside the container (claude only, no one-click update).')
  $L.Add('# The ssh transport needs a POSIX host: use ./install.sh from WSL 2 for it.')
  kv 'SWARM_OS_AGENT_TRANSPORT' 'local'
  $L.Add('')
  $L.Add('# -- Providers --')
  kv 'SWARM_OS_DEFAULT_PROVIDER' 'claude'
  $L.Add('# Empty = that provider''s own default model, kept current from models.dev.')
  kv 'SWARM_OS_DEFAULT_MODEL'; kv 'SWARM_OS_DEFAULT_EFFORT' 'xhigh'
  $L.Add('')
  $L.Add('# -- Remote access & notifications --')
  kv 'SWARM_OS_PUBLIC_URL'; kv 'SWARM_OS_DISCORD_WEBHOOK_URL'
  $L.Add('')
  $L.Add('# -- Update detection --')
  $L.Add('# Read-only GitHub PAT, any scope (the read:packages one works). Empty = never announce releases.')
  kv 'SWARM_OS_GITHUB_TOKEN'
  $L.Add('')
  $L.Add('# -- Envelopes --')
  kv 'SWARM_OS_MAX_ORCHESTRATORS' '10'; kv 'SWARM_OS_MAX_WORKERS_PER_ORCH' '20'; kv 'SWARM_OS_LOG_LEVEL' 'info'
  $L.Add('# First-boot seed only: afterwards the IDE is toggled from the Plugins screen.')
  kv 'SWARM_OS_IDE_ENABLED' 'true'; kv 'SWARM_OS_IDE_PORT' '8790'

  $tmp = "$path.tmp.$PID"
  Write-TextNoBom $tmp (($L -join "`n") + "`n")
  Move-Item -Force -LiteralPath $tmp -Destination $path
  # The chmod 600 of install.sh: only this account may read the file (tokens).
  # (M), not (R,W): the next -Reconfigure replaces this file, which needs delete.
  $global:LASTEXITCODE = 1
  if (Have 'icacls') { & icacls $path /inheritance:r /grant:r "$($env:USERNAME):(M)" *> $null }
  if ($LASTEXITCODE -eq 0) { Ok "wrote $path (readable by $($env:USERNAME) only -- it holds your tokens)" }
  else { Ok "wrote $path"; Warn 'could not restrict its permissions -- it holds your tokens.' }
}

# =============================================================================
# Deploy -- shared by the wizard's last step and by every plain re-run
# =============================================================================
$script:ComposeArgs = @()

function Load-Env {
  $path = $script:EnvFilePath
  if (-not (Test-Path -LiteralPath $path)) { Die "no $path -- run .\install.ps1 in a console to go through the wizard." }
  $e = Read-EnvFile $path
  # Export every value (paths expanded) so compose interpolates from them -- the
  # `set -a; source .env` of install.sh. A hand-edited ${HOME}/... must expand,
  # and HOME is not a variable Windows sets.
  if (-not $env:HOME) { $env:HOME = $HOME.Replace('\', '/') }
  foreach ($k in @($e.Keys)) {
    $v = $e[$k]
    if ($k -in 'WORKSPACE_PATH', 'DATA_PATH', 'CLAUDE_DIR', 'CLAUDE_JSON', 'HOST_SSH_DIR' -and $v) { $v = Expand-UserPath $v }
    $e[$k] = $v
    [Environment]::SetEnvironmentVariable($k, $v, 'Process')
  }
  $script:C = $e
  if (-not (Cfg 'SWARM_OS_IMAGE')) { Die "SWARM_OS_IMAGE is empty -- set it in $path" }
  if (-not (Cfg 'SWARM_OS_CONTAINER_NAME')) { $script:C['SWARM_OS_CONTAINER_NAME'] = 'swarm-os' }
  if (-not (Cfg 'SWARM_OS_PORT')) { $script:C['SWARM_OS_PORT'] = '8787' }
  $ws = Cfg 'WORKSPACE_PATH'; $data = Cfg 'DATA_PATH'
  if (-not $ws) { Die "WORKSPACE_PATH is empty in $path" }
  if (-not (Test-Path -LiteralPath $ws -PathType Container)) { Die "WORKSPACE_PATH does not exist: $ws" }
  if (-not $data) { Die "DATA_PATH is empty in $path" }
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  foreach ($k in 'CLAUDE_DIR', 'CLAUDE_JSON') {
    if (-not (Cfg $k)) {
      $d = if ($k -eq 'CLAUDE_DIR') { Join-Path $HOME '.claude' } else { Join-Path $HOME '.claude.json' }
      $script:C[$k] = $d.Replace('\', '/'); [Environment]::SetEnvironmentVariable($k, $script:C[$k], 'Process')
    }
  }

  $script:ComposeArgs = @($script:ComposeBase) + @('--env-file', $path, '-f', $script:ComposeDist)
  if ((Cfg 'SWARM_OS_AGENT_TRANSPORT' 'local') -eq 'ssh') {
    Warn 'this env file asks for the ssh transport, which needs a POSIX host -- expect agents to fail on Windows.'
    Note 'deploy it with ./install.sh from WSL 2, or set SWARM_OS_AGENT_TRANSPORT=local'
    if (-not (Test-Path -LiteralPath $script:ComposeSsh)) { Die "transport is ssh but $($script:ComposeSsh) is missing from this kit." }
    $script:ComposeArgs += @('-f', $script:ComposeSsh)
  }
}

function Invoke-Compose([string[]]$More) { & $script:ComposeExe @($script:ComposeArgs + $More) }

function Build-OrPull {
  $img = Cfg 'SWARM_OS_IMAGE'
  if (Test-RegistryImage $img) {
    Say "Pulling $img"
    & docker pull $img
    if ($LASTEXITCODE -ne 0) {
      Warn 'Pull failed. For a private registry, log in first:'
      Note "docker login $($img.Split('/')[0]) -u <github-user>   (password: a PAT with read:packages)"
      Die 'could not pull the image.'
    }
    return
  }
  # No registry path -> a locally built tag. Build it if it is not there yet.
  if ((Test-Native { docker image inspect $img }) -and $script:ImageSource -ne 'local') { Ok "using the local image $img"; return }
  if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot 'Dockerfile'))) { Die "$img is not in a registry and there is no Dockerfile here." }
  Say "Building $img from source (this takes a few minutes) ..."
  & docker build -t $img $script:RepoRoot
  if ($LASTEXITCODE -ne 0) { Die 'the image build failed.' }
  Ok "built $img"
}

function Wait-Healthy {
  $url = "http://127.0.0.1:$(Cfg 'SWARM_OS_PORT')/health"
  Say "Waiting for $url ..."
  $answered = $false
  for ($i = 1; $i -le 90; $i++) {
    try {
      $h = Invoke-RestMethod -Uri $url -TimeoutSec 3 -ErrorAction Stop
      $answered = $true
      if ($h.boot_complete -eq $true) { Ok 'server healthy, auto-resume finished'; return }
      if ($i % 5 -eq 0) { Note 'up, still replaying teams (boot_complete=false) ...' }
    } catch { }
    Start-Sleep -Seconds 1
  }
  if ($answered) {
    Warn 'the server answers /health but has not finished booting; business routes answer 503 until it does.'
    return
  }
  Warn 'the server never answered. Recent logs:'
  Invoke-Compose @('logs', '--tail', '40')
  Die 'startup failed.'
}

function Read-Token {
  $name = Cfg 'SWARM_OS_CONTAINER_NAME'
  for ($i = 0; $i -lt 10; $i++) {
    $t = (& docker exec $name cat /data/token 2>$null | Out-String).Trim()
    if ($t) { return $t }
    Start-Sleep -Seconds 1
  }
  return ''
}

# What the instance itself thinks of each provider -- the answer to the most
# common "why is codex greyed out?" question, before it gets asked.
function Show-Providers([string]$Tok) {
  try {
    $d = Invoke-RestMethod -Uri "http://127.0.0.1:$(Cfg 'SWARM_OS_PORT')/providers" -Headers @{ 'X-Auth-Token' = $Tok } -TimeoutSec 5 -ErrorAction Stop
  } catch { return }
  if (-not $d.providers) { return }
  W ''
  W '  Providers as this instance sees them:' 'White'
  foreach ($p in $d.providers) {
    if ($p.available) { W ('     ok {0,-9}' -f $p.id) }
    else {
      $why = if ($p.unavailableReason) { $p.unavailableReason } else { 'unavailable' }
      W ('     -- {0,-9}  ({1})' -f $p.id, $why) 'DarkGray'
    }
  }
}

function Deploy {
  Step 'Deploy' 'pull, start, wait for the boot gate, hand you the token'
  Build-OrPull
  Say "Starting $(Cfg 'SWARM_OS_CONTAINER_NAME') ..."
  Invoke-Compose @('up', '-d')
  if ($LASTEXITCODE -ne 0) { Die '`compose up` failed.' }
  Wait-Healthy

  $tok = Read-Token
  $port = Cfg 'SWARM_OS_PORT'
  W ''
  W '  swarm-os is up.' 'Green'
  W '  URL     ' 'DarkGray' -NoNewline; W "http://127.0.0.1:$port"
  if (Cfg 'SWARM_OS_PUBLIC_URL') { W '  remote  ' 'DarkGray' -NoNewline; W (Cfg 'SWARM_OS_PUBLIC_URL') }
  if ($tok) {
    W '  token   ' 'DarkGray' -NoNewline; W $tok 'White'
    Note '   paste it into the Token panel -- it is stored in the browser localStorage'
    Show-Providers $tok
  } else {
    Warn 'could not read the token automatically:'
    Note "docker exec $(Cfg 'SWARM_OS_CONTAINER_NAME') cat /data/token"
  }

  $composeLine = (@($script:ComposeExe) + $script:ComposeArgs) -join ' '
  W ''
  W '  Next' 'White'
  W "     open:              Start-Process http://127.0.0.1:$port"
  W "     logs:              $composeLine logs -f"
  W '     reconfigure:       .\install.ps1 -Reconfigure'
  W '     update:            .\install.ps1'
  W '     docs:              docs/deploy/install.en.md - docs/deploy/usage.en.md (FR available)'
  W ''
}

# =============================================================================
# Wizard driver + entry point
# =============================================================================
function Run-Wizard {
  Banner
  Note 'Eight steps. Every default in [brackets] is a working answer -- press enter to take it.'
  Note 'Nothing is installed or written without a confirmation naming the command.'

  # Seed the defaults from an existing config when reconfiguring.
  $script:C = Read-EnvFile $script:EnvFilePath

  Wiz-Prereqs
  Wiz-Identity
  Wiz-Image
  Wiz-Transport
  Wiz-Access
  Wiz-Notifications
  Wiz-Advanced
  Wiz-Review
  Write-Env
  Load-Env
  $script:StepTotal = 9
  Deploy
}

function Show-Usage {
  W @'
swarm-os -- guided installer for Windows.

  .\install.ps1                 wizard on first run, deploy afterwards
  .\install.ps1 -Reconfigure    re-run the wizard, current values as defaults
  .\install.ps1 -Yes            non-interactive: no questions, deploy from .env
  .\install.ps1 -EnvFile P      use env file P instead of .\.env

When the kit is not next to the script (e.g. `irm ... | iex`), it is fetched first:
  -Dir <path>     where to put the kit     (default ~\swarm-os, or $env:SWARM_OS_DIR)
  -Ref <ref>      branch or tag to fetch   (default master, or $env:SWARM_OS_REF)
  -Token <pat>    only for a private fork/mirror ($env:SWARM_OS_REPO)

If script execution is disabled on this machine:
  powershell -ExecutionPolicy Bypass -File .\install.ps1
'@
}

function Invoke-Main {
  if ($Help) { Show-Usage; return }

  # Where the kit lives: beside the script, or the current directory under
  # `irm | iex` (no script path then).
  $script:RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
  if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot $script:ComposeDist))) {
    $target = if ($Dir) { $Dir } elseif ($env:SWARM_OS_DIR) { $env:SWARM_OS_DIR } else { Join-Path $HOME 'swarm-os' }
    $target = (Expand-UserPath $target).Replace('/', '\')
    if (-not (Test-Path -LiteralPath (Join-Path $target $script:ComposeDist))) {
      Banner
      Warn "no $($script:ComposeDist) next to this script (looked in $($script:RepoRoot))."
      if (-not (Ask-YN "Fetch the deploy kit into $target?" 'y')) { Die 'kit incomplete.' }
      $gitRef = if ($Ref) { $Ref } elseif ($env:SWARM_OS_REF) { $env:SWARM_OS_REF } else { 'master' }
      $pat = if ($Token) { $Token } elseif ($env:SWARM_OS_PAT) { $env:SWARM_OS_PAT } else { '' }
      Get-Kit $target $gitRef $pat
    }
    $script:RepoRoot = $target
  }
  Set-Location -LiteralPath $script:RepoRoot

  $script:EnvFilePath = if ($EnvFile) { (Expand-UserPath $EnvFile) } else { (Join-Path $script:RepoRoot '.env').Replace('\', '/') }

  if ($Reconfigure) {
    if (-not $script:Interactive) { Die '-Reconfigure needs a console to ask questions on.' }
    Run-Wizard; return
  }

  if (-not (Test-Path -LiteralPath $script:EnvFilePath)) {
    if ($script:Interactive) { Run-Wizard; return }
    # No console and no config: fall back to the copy-and-edit path rather than
    # guessing answers nobody can confirm.
    Copy-Item -LiteralPath (Join-Path $script:RepoRoot '.env.example') -Destination $script:EnvFilePath
    Warn "created $($script:EnvFilePath) from .env.example (no console to run the wizard on)."
    Warn 'edit it, then re-run .\install.ps1 -- or run it interactively for the guided setup.'
    return
  }

  # Config already there. A plain re-run deploys; the wizard is one keystroke away.
  Banner
  if ($script:Interactive) {
    Say "Found an existing configuration: $($script:EnvFilePath)"
    $what = Choose 1 @(
      @('deploy', 'Deploy it as it stands', 'pull + up -d + health check -- this is also how you update'),
      @('reconfigure', 'Re-run the wizard', 'current values become the defaults'),
      @('quit', 'Quit', '')
    )
    if ($what -eq 'reconfigure') { Run-Wizard; return }
    if ($what -eq 'quit') { return }
  }
  $script:StepTotal = 1; $script:StepN = 0
  Check-Docker
  Load-Env
  Deploy
}

$script:ExitCode = 0
$here = Get-Location
try {
  Invoke-Main
} catch {
  $msg = "$($_.Exception.Message)"
  if ($msg -eq $script:DoneMarker) { $script:ExitCode = 0 }
  elseif ($msg -eq $script:DieMarker) { $script:ExitCode = 1 }
  else { W " [x] unexpected error: $msg" 'Red'; W "     $($_.InvocationInfo.PositionMessage)" 'DarkGray'; $script:ExitCode = 1 }
}
# `exit` only when run as a file: under `irm | iex` it would close the window.
if ($PSCommandPath) { exit $script:ExitCode }
$global:LASTEXITCODE = $script:ExitCode
