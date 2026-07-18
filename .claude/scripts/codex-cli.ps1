# Resolves the path to the working Codex CLI binary.
#
# Why this exists: the ChatGPT/Codex desktop app ships two binaries.
#   - %LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe        -> stable path, but STALE.
#     It lags behind the desktop app and dies parsing the config the app itself
#     writes (e.g. `service_tier = "default"` -> "unknown variant `default`").
#   - %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe -> current, but the <hash>
#     directory changes on every update, so it cannot be hardcoded.
#
# The authoritative pointer is CODEX_CLI_PATH in ~/.codex/config.toml, which the
# desktop app keeps up to date. Fall back to the newest binary on disk.
#
# Usage:  $cli = & .claude/scripts/codex-cli.ps1
#         & $cli exec --sandbox read-only "..."

$ErrorActionPreference = 'Stop'

$configPath = Join-Path $env:USERPROFILE '.codex\config.toml'

if (Test-Path $configPath) {
    $match = Select-String -Path $configPath -Pattern "^\s*CODEX_CLI_PATH\s*=\s*['`"](.+)['`"]" |
             Select-Object -First 1
    if ($match) {
        $candidate = $match.Matches[0].Groups[1].Value
        if (Test-Path $candidate) {
            Write-Output $candidate
            exit 0
        }
    }
}

# Fallback: newest codex.exe under the install root, preferring hashed subdirs
# over the stale top-level launcher.
$binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
if (Test-Path $binRoot) {
    $found = Get-ChildItem -Path $binRoot -Recurse -Filter 'codex.exe' -ErrorAction SilentlyContinue |
             Sort-Object @{ Expression = { $_.DirectoryName -ne $binRoot } }, LastWriteTime -Descending |
             Select-Object -First 1
    if ($found) {
        Write-Output $found.FullName
        exit 0
    }
}

Write-Error "Codex CLI not found. Checked CODEX_CLI_PATH in $configPath and $binRoot."
exit 1
