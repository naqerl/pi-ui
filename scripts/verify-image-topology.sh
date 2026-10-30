#!/usr/bin/env bash
# Assert what this image actually provides: identity, runtimes, pi wiring and the
# browser stack a Playwright run depends on. Every value below is measured.
set -euo pipefail

failures=0
rows=()
pass() { rows+=("PASS|$1|$2"); }
warn() { rows+=("WARN|$1|$2"); }
fail() { rows+=("FAIL|$1|$2"); failures=$((failures + 1)); }
section() { printf '\n== %s ==\n' "$1"; }
value() { printf '%-22s %s\n' "$1" "$2"; }

section "identity"
uname_value=$(uname -srmo)
value "uname -srmo" "$uname_value"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  pretty=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")
else
  pretty="no /etc/os-release"
fi
value "PRETTY_NAME" "$pretty"
cores=$(nproc)
value "nproc" "$cores"
printf 'free -m\n'
free -m
printf 'df -h /\n'
df -h /
printf 'df -h /opt\n'
df -h /opt
if [ -r /sys/fs/cgroup/cpu.max ]; then
  cpu_max=$(cat /sys/fs/cgroup/cpu.max)
else
  cpu_max="not present"
fi
value "cpu.max" "$cpu_max"
if [ -r /sys/fs/cgroup/memory.max ]; then
  memory_max=$(cat /sys/fs/cgroup/memory.max)
else
  memory_max="not present"
fi
value "memory.max" "$memory_max"
if [ "$cores" -ge 1 ] && [ -n "$pretty" ]; then
  pass "identity" "Linux, ${pretty}, ${cores} cpus, ${memory_max} memory.max"
else
  fail "identity" "could not read cpu or os identity"
fi

section "runtimes"
runtime_detail=""
for tool in node npm git python3 chromium zeroshot; do
  if command -v "$tool" >/dev/null 2>&1; then
    case "$tool" in
      node) out=$(node --version) ;;
      npm) out=$(npm --version) ;;
      git) out=$(git --version) ;;
      python3) out=$(python3 --version 2>&1) ;;
      chromium) out=$(chromium --version 2>&1 | head -n 1) ;;
      zeroshot) out=$(zeroshot --version 2>&1 | head -n 1) ;;
    esac
    value "$tool" "$out"
    runtime_detail="${runtime_detail}${tool}=${out}; "
  else
    value "$tool" "MISSING"
    fail "runtime $tool" "command not found"
  fi
done
for tool in go cargo; do
  if command -v "$tool" >/dev/null 2>&1; then
    out=$("$tool" version 2>&1 | head -n 1)
    value "$tool" "$out"
    warn "runtime $tool (optional)" "$out"
  else
    value "$tool" "MISSING (optional)"
    warn "runtime $tool (optional)" "not installed"
  fi
done
if [ "${#rows[@]}" -gt 0 ] && ! printf '%s\n' "${rows[@]}" | grep -q '^FAIL|runtime '; then
  pass "required runtimes" "${runtime_detail}"
fi

section "image identity"
marker=""
for candidate in /etc/zeroshot-image /opt/zeroshot/IMAGE /opt/zeroshot/VERSION; do
  if [ -r "$candidate" ]; then
    marker="$candidate"
    value "$candidate" "$(head -n 5 "$candidate" | tr '\n' ' ')"
  fi
done
if [ -n "${ZEROSHOT_IMAGE:-}" ]; then
  marker="${marker:-ZEROSHOT_IMAGE}"
  value "ZEROSHOT_IMAGE" "$ZEROSHOT_IMAGE"
fi
if [ -z "$marker" ]; then
  value "image marker" "no marker file"
  pass "image identity" "no marker file (checked 4 known locations)"
else
  pass "image identity" "$marker"
fi
if [ -r /usr/local/bin/pi ]; then
  printf '\n/usr/local/bin/pi (first 20 lines)\n'
  head -n 20 /usr/local/bin/pi
else
  fail "pi launcher" "/usr/local/bin/pi is missing"
fi
if [ -r /opt/zeroshot/pi-extensions/list ]; then
  printf '\n/opt/zeroshot/pi-extensions/list\n'
  while IFS= read -r line; do printf '%s\n' "$line"; done </opt/zeroshot/pi-extensions/list
  extensions_file=/opt/zeroshot/pi-extensions/list
else
  value "pi extension list" "not present"
  extensions_file=""
fi

section "pi"
pi_version=$(pi --version 2>&1 | head -n 1)
value "pi --version" "$pi_version"
if [ -r /usr/local/bin/pi ]; then
  executable_lines=$(grep -v '^[[:space:]]*#' /usr/local/bin/pi || true)
  if printf '%s\n' "$executable_lines" | grep -q -- '--no-extensions'; then
    no_extensions="yes"
  else
    no_extensions="no"
  fi
else
  no_extensions="unknown"
fi
value "launcher --no-extensions" "$no_extensions"
if [ -n "$extensions_file" ]; then
  enabled=$(grep -cve '^[[:space:]]*$' "$extensions_file" || true)
  value "extensions the launcher adds" "$enabled"
  while IFS= read -r ext; do
    [ -n "$ext" ] && value "  extension" "$ext"
  done <"$extensions_file"
else
  enabled=0
  value "extensions the launcher adds" "0 (no list file)"
fi
if [ "$no_extensions" = "yes" ]; then
  pass "pi launcher" "pi ${pi_version}, passes --no-extensions, ${enabled} explicit extensions"
else
  pass "pi launcher" "pi ${pi_version}, does not pass --no-extensions, ${enabled} explicit extensions"
fi

section "browser stack"
if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  browsers_path=$PLAYWRIGHT_BROWSERS_PATH
  browsers_source="PLAYWRIGHT_BROWSERS_PATH"
else
  value "PLAYWRIGHT_BROWSERS_PATH" "unset"
  if [ -d /opt/playwright ]; then
    browsers_path=/opt/playwright
    browsers_source="fallback /opt/playwright (env unset)"
  else
    browsers_path="${HOME:-/tmp}/.cache/ms-playwright"
    browsers_source="fallback ${browsers_path} (env unset)"
  fi
fi
value "browsers path" "${browsers_path} (${browsers_source})"
if [ -d "$browsers_path" ]; then
  printf 'ls -1 %s\n' "$browsers_path"
  ls -1 "$browsers_path"
  pass "browser cache directory" "$browsers_path"
else
  fail "browser cache directory" "$browsers_path does not exist"
fi

present_chromium=()
present_shell=()
if [ -d "$browsers_path" ]; then
  while IFS= read -r dir; do
    [ -n "$dir" ] && present_chromium+=("$(basename "$dir")")
  done < <(find "$browsers_path" -mindepth 1 -maxdepth 1 -type d -name 'chromium-*' | sort)
  while IFS= read -r dir; do
    [ -n "$dir" ] && present_shell+=("$(basename "$dir")")
  done < <(find "$browsers_path" -mindepth 1 -maxdepth 1 -type d -name 'chromium_headless_shell-*' | sort)
fi
value "chromium dirs" "${present_chromium[*]:-none}"
value "headless shell dirs" "${present_shell[*]:-none}"
if [ "${#present_chromium[@]}" -gt 0 ]; then
  pass "chromium revisions present" "${present_chromium[*]}"
else
  fail "chromium revisions present" "no chromium-<rev> directory"
fi

probe=/tmp/pwprobe
rm -rf "$probe"
probe_cache="${TMPDIR:-/tmp}/pwprobe-npm-cache"
mkdir -p "$probe_cache"
if npm_config_cache="$probe_cache" npm i --silent --prefix "$probe" playwright-core >/tmp/pwprobe-install.log 2>&1; then
  pw_version=$(node -e 'process.stdout.write(require("/tmp/pwprobe/node_modules/playwright-core/package.json").version)')
  required_rev=$(node -e 'const b=require("/tmp/pwprobe/node_modules/playwright-core/browsers.json"); process.stdout.write(b.browsers.find(x=>x.name==="chromium").revision)')
  required_shell=$(node -e 'const b=require("/tmp/pwprobe/node_modules/playwright-core/browsers.json"); const x=b.browsers.find(y=>y.name==="chromium-headless-shell"); process.stdout.write(x?x.revision:"none")')
  value "playwright-core" "$pw_version"
  value "required chromium rev" "$required_rev"
  value "required shell rev" "$required_shell"
  printf '\n%-28s %s\n' "required" "present"
  printf '%-28s %s\n' "chromium-${required_rev}" "${present_chromium[*]:-none}"
  printf '%-28s %s\n' "chromium_headless_shell-${required_shell}" "${present_shell[*]:-none}"
  if [ -d "$browsers_path/chromium-$required_rev" ]; then
    pass "required chromium revision" "required ${required_rev}, present ${present_chromium[*]}"
  else
    fail "required chromium revision" "required ${required_rev}, present ${present_chromium[*]:-none}"
  fi
  if [ "$required_shell" = "none" ] || [ -d "$browsers_path/chromium_headless_shell-$required_shell" ]; then
    pass "required headless revision" "required ${required_shell}, present ${present_shell[*]:-none}"
  else
    fail "required headless revision" "required ${required_shell}, present ${present_shell[*]:-none}"
  fi
else
  tail -n 20 /tmp/pwprobe-install.log || true
  fail "playwright-core probe" "npm install playwright-core failed"
  fail "required chromium revision" \
    "playwright-core probe failed; required revision unknown, present ${present_chromium[*]:-none}"
  fail "required headless revision" \
    "playwright-core probe failed; required revision unknown, present ${present_shell[*]:-none}"
fi

if [ -d "$browsers_path" ] && [ -w "$browsers_path" ]; then
  probe_file="$browsers_path/.topology-write-probe-$$"
  if (umask 077 && : >"$probe_file") && [ -f "$probe_file" ]; then
    rm -f "$probe_file"
    pass "browser cache writable" "$browsers_path (created and deleted a real file)"
  else
    fail "browser cache writable" "$browsers_path (could not create a file)"
  fi
else
  fail "browser cache writable" "$browsers_path (test -w failed)"
fi

shot=/tmp/topology-blank.png
rm -f "$shot"
chrome_home="${TMPDIR:-/tmp}/topology-chrome-home"
chrome_profile="${TMPDIR:-/tmp}/topology-chrome-profile"
rm -rf "$chrome_home" "$chrome_profile"
mkdir -p "$chrome_home" "$chrome_profile"
chrome_args=(--headless=new --no-sandbox --disable-gpu --user-data-dir="$chrome_profile"
  --screenshot="$shot" --window-size=800,600 about:blank)
if command -v chromium-shot >/dev/null 2>&1; then
  capture_cmd=(chromium-shot about:blank "$shot" 800x600)
else
  capture_cmd=(chromium "${chrome_args[@]}")
fi
value "capture command" "${capture_cmd[*]}"
if HOME="$chrome_home" timeout 60 "${capture_cmd[@]}" >/tmp/topology-chromium.log 2>&1; then
  if [ -f "$shot" ]; then
    bytes=$(wc -c <"$shot" | tr -d ' ')
    dims=$(node -e 'const fs=require("fs"); const b=fs.readFileSync(process.argv[1]); process.stdout.write(`${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`)' "$shot")
    value "screenshot bytes" "$bytes"
    value "screenshot dimensions" "$dims"
    if [ "$bytes" -gt 2048 ]; then
      pass "headless capture" "${bytes} bytes, ${dims}"
    else
      fail "headless capture" "${bytes} bytes is not larger than 2048"
    fi
    if [ "$dims" = "800x600" ]; then
      pass "screenshot dimensions" "$dims"
    else
      fail "screenshot dimensions" "expected 800x600, got $dims"
    fi
  else
    fail "headless capture" "chromium exited 0 but wrote no screenshot"
  fi
else
  tail -n 20 /tmp/topology-chromium.log || true
  fail "headless capture" "chromium could not launch headless as uid $(id -u)"
fi
rm -rf "$chrome_home" "$chrome_profile"

section "conclusion"
printf '%-6s %-30s %s\n' "STATUS" "ASSERTION" "MEASURED"
for row in "${rows[@]}"; do
  IFS='|' read -r status name detail <<<"$row"
  printf '%-6s %-30s %s\n' "$status" "$name" "$detail"
done
if [ "$failures" -ne 0 ]; then
  printf '\ntopology: FAIL (%d assertion(s))\n' "$failures"
  exit 1
fi
printf '\ntopology: OK\n'
