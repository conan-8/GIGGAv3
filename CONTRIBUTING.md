# Contributing to GIGGA

One-pager. GIGGA is an opencode plugin + agent pack; the ground rules from
the project's development sessions still apply: no invented opencode APIs
(everything verified goes in DEVIATIONS.md), read-only agents stay
read-only, and the shared config logic stays shared.

## Setup

```bash
git clone https://github.com/conan-8/GIGGAv3.git
cd GIGGAv3
bash install.sh   # installs into your ~/.config/opencode (GIGGA_HOME=… to sandbox)
```

## Running the tests

```bash
# unit tests (config validation, state paths, recovery, CLI) — fast, no network
node --test dashboard/test/*.test.mjs

# end-to-end (needs opencode + provider auth; drives a sandboxed server)
bash test/e2e_driver.sh > /tmp/results.md        # scenarios A–F
bash test/e2e_wizard.sh > /tmp/wizard.md         # setup wizard
bash test/e2e_focus.sh > /tmp/focus.md           # edge cases
bash test/e2e_soak.sh > /tmp/soak.md             # concurrency + kill -9

# spec compliance audit
$EDITOR test/COMPLIANCE.md   # keep rows green; add evidence, not vibes
```

E2E scripts are self-sandboxing (fresh HOME, fixture git repos, isolated
ports). Kill strays with `bash test/stop_servers.sh <port>`.

## Layout

- `agents/` — the 8 opencode agent definitions (orchestrator, recon,
  checker, fasttrack, config, 3 worker tiers)
- `commands/` — /gigga-setup, /gigga-fasttrack, /gigga-retry, /gigga-status
- `plugin/gigga.ts` — state machine, signaling, enforcement
- `dashboard/` — zero-dep node server + vanilla UI (+ `lib/shared.mjs`,
  the one true config implementation)
- `test/` — e2e drivers, fixtures, COMPLIANCE.md, results

## Conventions

- Small, descriptive commits on `main`; tag releases only with a green
  (or explicitly escalated) COMPLIANCE.md.
- Every opencode-API surprise → `DEVIATIONS.md` before code.
- Results files under `test/results/` contain real transcripts; never
  paraphrase them.
