# Running an isolated app instance (QA)

For tests that drive a real window while another instance runs (MIP2-1408).

```sh
# 1. Build outside this repo (writes nothing here):
npm run build -- --outdir /path/to/qa-build

# 2. A private parent folder for the channel root (the app refuses one open to other users):
mkdir -m 700 /tmp/ccc-qa

# 3. Start it, isolated, with the test port:
CCC_QA=1 \
CCC_USER_DATA=/tmp/ccc-qa/data \
CCC_CHANNEL_ROOT=/tmp/ccc-qa/ch \
CLAUDE_CONFIG_DIR=~/.claude-ccc-qa \
<this repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /path/to/qa-build --remote-debugging-port=9335
```

| Variable | Does | Refused when |
|---|---|---|
| `CCC_USER_DATA` | The Chromium profile and `self-check.json` | Not absolute; the app's own folder; inside any Electron CCCC folder |
| `CCC_CHANNEL_ROOT` | Where launch channels live | Not absolute; overlapping `~/.ccc/ch`; long enough to push a socket path past 100 bytes; its parent is open to other users |
| `CCC_QA=1` | Lets `--remote-debugging-port` open | The build is packaged (the port is always refused there) |
| `CCC_QA_PICK_PATHS` | `/abs/a:/abs/b`: ⌘O inserts these paths instead of opening the panel; quoting and the bracketed paste stay real (MIP2-1413) | `CCC_QA` isn't `1`; the build is packaged; a path isn't absolute |
| `CCC_IMPORT_FROM` | The folder whose `registry.db` the 0.24 import reads, e.g. a copy (MIP2-1409). Read through a private copy, never written | Not absolute |
| `CLAUDE_CONFIG_DIR` | Claude Code's own config, and so a separate supervisor | Claude Code's rules |

A refused setup prints `CC Command Center can't start: <reason>` and exits 1.

Not isolated by these: the reporter mod writes the usage governor's files under `$HOME/.claude/ccc/usage/`.
