#!/usr/bin/env bash
# Clean-machine verification: real one-liner against the real GitHub repo,
# then the A–F scenario suite, in an isolated HOME with a minimal PATH.
#
#   bash test/clean_machine.sh <logfile>
#
# Requires: network, opencode on the real PATH, opencode auth (copied in).
# Run AFTER `git push origin main` (and tag).
set -u
OWNER="${GIGGA_OWNER:-conan-8}"
LOG="${1:-/tmp/gigga-clean-machine.log}"
CM="$(mktemp -d /tmp/gigga-clean.XXXXXX)"
export HOME="$CM/home"
mkdir -p "$HOME"
MYPATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
REAL_HOME="${SUDO_OR_REAL_HOME:-$HOME}"

exec > >(tee -a "$LOG") 2>&1
echo "=== GIGGA clean-machine install — $(date -u +%FT%TZ)"
echo "clean HOME: $HOME (opencode: $(env PATH=$MYPATH sh -c 'command -v opencode' || echo MISSING))"

echo
echo "=== 1. the REAL one-liner"
env -i HOME="$HOME" PATH="$MYPATH" TERM=xterm \
  bash -c 'set -o pipefail; curl -fsSL https://raw.githubusercontent.com/'"$OWNER"'/GIGGAv3/main/install.sh | bash'
RC=$?
echo "one-liner rc=$RC"
[ $RC -ne 0 ] && { echo "INSTALL FAILED — aborting"; exit 1; }

echo
echo "=== 2. landed files"
find "$HOME/.config/opencode" -maxdepth 2 -type f | sort | head -30
echo "opencode.json:"; cat "$HOME/.config/opencode/opencode.json"

echo
echo "=== 3. idempotency (second run)"
env -i HOME="$HOME" PATH="$MYPATH" TERM=xterm \
  bash -c 'set -o pipefail; curl -fsSL https://raw.githubusercontent.com/'"$OWNER"'/GIGGAv3/main/install.sh | bash' | tail -6

echo
echo "=== 4. failure mode: opencode missing"
BINS="$(mktemp -d)"
env -i HOME="$HOME" PATH="$BINS:/usr/bin:/bin" bash -c '
  set -o pipefail; curl -fsSL https://raw.githubusercontent.com/'$OWNER'/GIGGAv3/main/install.sh | bash ; echo "rc=$? (expect 1)"
rm -rf "$BINS"

echo
echo "=== 5. A–F scenario suite (from the GitHub clone)"
cp "$REAL_HOME/.local/share/opencode/auth.json" "$HOME/.local/share/opencode/auth.json" 2>/dev/null \
  || echo "WARN: no opencode auth to copy — provider calls will fail"
git clone -q "https://github.com/$OWNER/GIGGAv3.git" "$CM/repo"
( cd "$CM/repo" && bash test/e2e_driver.sh )
echo "=== suite rc=$?"

echo
echo "=== 6. gigga-dashboard smoke"
env -i HOME="$HOME" PATH="$MYPATH" timeout 5 gigga-dashboard --port 4498 --no-open | head -3

echo "=== clean-machine run complete"
