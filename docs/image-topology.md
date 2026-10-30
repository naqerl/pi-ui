# Image topology

Measured **2026-10-30** on this pool target, by running the probe below. Every value here is a measurement from this box, not a category or a recollection.

- Probe: `bash scripts/verify-image-topology.sh`
- Build ref: `8567524ab941528f6b3439f1d76a2ba815270f81` (`git rev-parse HEAD` of this checkout when captured)
- `PLAYWRIGHT_BROWSERS_PATH` is unset in this shell; the probe resolves the image cache at its conventional `/opt/playwright` location and still asserts the revision, writability and a real capture.

## Probe output

```text

== identity ==
uname -srmo            Linux 6.8.0-52-generic x86_64 GNU/Linux
PRETTY_NAME            Debian GNU/Linux 13 (trixie)
nproc                  2
free -m
               total        used        free      shared  buff/cache   available
Mem:            3820         745        1304           4        2069        3074
Swap:              0           0           0
df -h /
Filesystem      Size  Used Avail Use% Mounted on
overlay          38G   26G  9.7G  73% /
df -h /opt
Filesystem      Size  Used Avail Use% Mounted on
overlay          38G   26G  9.7G  73% /
cpu.max                max 100000
memory.max             max

== runtimes ==
node                   v24.22.2
npm                    11.19.1
git                    git version 2.47.3
python3                Python 3.12.14
chromium               Chromium 156.0.8078.73 built on Debian GNU/Linux 13 (trixie)
zeroshot               zeroshot 0.1.0
go                     go version go1.26.1 linux/amd64
cargo                  cargo 1.97.0 (c980f4866 2026-06-30)

== image identity ==
image marker           no marker file

/usr/local/bin/pi (first 20 lines)
#!/usr/bin/env bash
# The image's `pi` launcher.
#
# zeroshot launches pi for contained (hosted) placements with `--no-extensions`, which turns
# off *discovery* of ambient extensions, MCP servers, skills and project-local resources so a
# workspace cannot inject them. Explicit `--extension PATH` arguments are still honored — that
# is exactly how zeroshot injects its own active-memory hook on the same argv. This launcher
# uses that documented escape hatch to load the image's own extensions.
#
# The extensions are prepended so they cannot be mistaken for the prompt, which zeroshot passes
# as a positional argument.
set -euo pipefail

args=()
if [ -r /opt/zeroshot/pi-extensions/list ]; then
  while IFS= read -r extension; do
    [ -n "$extension" ] && args+=(--extension "$extension")
  done </opt/zeroshot/pi-extensions/list
fi


/opt/zeroshot/pi-extensions/list
/opt/zeroshot/pi-extensions/lib/node_modules/billion-context/dist/agent/pi-native.js
/opt/zeroshot/pi-extensions/lib/node_modules/pi-web-access/dist
/opt/zeroshot/pi-extensions/lib/node_modules/@bytetrue/pi-background-terminal/src/index.ts

== pi ==
pi --version           1.4.0
launcher --no-extensions no
extensions the launcher adds 3
  extension            /opt/zeroshot/pi-extensions/lib/node_modules/billion-context/dist/agent/pi-native.js
  extension            /opt/zeroshot/pi-extensions/lib/node_modules/pi-web-access/dist
  extension            /opt/zeroshot/pi-extensions/lib/node_modules/@bytetrue/pi-background-terminal/src/index.ts

== browser stack ==
PLAYWRIGHT_BROWSERS_PATH unset
browsers path          /opt/playwright (fallback /opt/playwright (env unset))
ls -1 /opt/playwright
chromium-1234
chromium-1248
chromium_headless_shell-1234
chromium_headless_shell-1248
ffmpeg-1011
ffmpeg-1013
chromium dirs          chromium-1234 chromium-1248
headless shell dirs    chromium_headless_shell-1234 chromium_headless_shell-1248
playwright-core        1.64.1
required chromium rev  1248
required shell rev     1248

required                     present
chromium-1248                chromium-1234 chromium-1248
chromium_headless_shell-1248 chromium_headless_shell-1234 chromium_headless_shell-1248
capture command        chromium --headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/zs-e5e0db248eb916f6/topology-chrome-profile --screenshot=/tmp/topology-blank.png --window-size=800,600 about:blank
screenshot bytes       2727
screenshot dimensions  800x600

== conclusion ==
STATUS ASSERTION                      MEASURED
PASS   identity                       Linux, Debian GNU/Linux 13 (trixie), 2 cpus, max memory.max
WARN   runtime go (optional)          go version go1.26.1 linux/amd64
WARN   runtime cargo (optional)       cargo 1.97.0 (c980f4866 2026-06-30)
PASS   required runtimes              node=v24.22.2; npm=11.19.1; git=git version 2.47.3; python3=Python 3.12.14; chromium=Chromium 156.0.8078.73 built on Debian GNU/Linux 13 (trixie); zeroshot=zeroshot 0.1.0;
PASS   image identity                 no marker file (checked 4 known locations)
PASS   pi launcher                    pi 1.4.0, does not pass --no-extensions, 3 explicit extensions
PASS   browser cache directory        /opt/playwright
PASS   chromium revisions present     chromium-1234 chromium-1248
PASS   required chromium revision     required 1248, present chromium-1234 chromium-1248
PASS   required headless revision     required 1248, present chromium_headless_shell-1234 chromium_headless_shell-1248
PASS   browser cache writable         /opt/playwright (created and deleted a real file)
PASS   headless capture               2727 bytes, 800x600
PASS   screenshot dimensions          800x600

topology: OK
```

## What this rules out

1. **A browser cache whose revision does not match the installed `playwright-core`.** The probe installs `playwright-core`, reads `node_modules/playwright-core/browsers.json`, asserts `chromium.revision` exists on disk, and prints required versus present side by side. Measured: required `1248`, present `chromium-1234` and `chromium-1248`; the assertion failed would exit non-zero. Commands: `npm i --silent --prefix /tmp/pwprobe playwright-core`, `node -e 'require("/tmp/pwprobe/node_modules/playwright-core/browsers.json")'`, `test -d "$PLAYWRIGHT_BROWSERS_PATH/chromium-$revision"`.
2. **A browser that cannot launch headless as a non-root user.** The probe runs Chromium as uid `20000` with `--headless=new --no-sandbox --disable-gpu`, captures `about:blank`, asserts the file is larger than 2 KB, and reads width/height from the PNG header. Measured: `2727` bytes, `800x600`. Command: `chromium --headless=new --no-sandbox --disable-gpu --user-data-dir=… --screenshot=/tmp/topology-blank.png --window-size=800,600 about:blank`, followed by `readUInt32BE(16)` / `readUInt32BE(20)` in node.
