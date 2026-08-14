#!/usr/bin/env bash
#
# E2E regression runner for billion-context-pi.
#
# For each scenario in scenarios/*.json:
#   1. Writes an isolated Pi HOME (models.json = fake provider, acp.json = scenario config)
#   2. Starts the fake LLM server (OpenAI-compatible SSE) seeded with the scenario
#   3. Drives real `pi -p` headless turns (continuing one session)
#   4. Locates the persisted ACP state file (<session>.jsonl.acp.json)
#   5. Runs verify.mjs to assert on block counts, nudge baselines, observations
#
# The fake LLM responds per a file-based turn counter, so each scenario turn maps
# to one real (non-auxiliary) LLM request. Turns marked "auto": true are tool-call
# follow-ups consumed within the previous `pi -p` invocation (no new user message).
#
# Usage: ./scripts/e2e/run-e2e.sh [scenario-filter]
#   scenario-filter = substring matched against scenario filenames (e.g. "01" or "nudge")
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PI_BIN="${PI_BIN:-./node_modules/.bin/pi}"
NODE_BIN="${NODE_BIN:-node}"
EXTENSION="${BCP_E2E_EXTENSION:-$ROOT/scripts/e2e/e2e-extension.js}"
FAKE_PORT="${FAKE_LLM_PORT:-8400}"
WORK_ROOT="${BCP_E2E_WORK_ROOT:-/tmp/bcp-e2e}"
SCENARIO_FILTER="${1:-}"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; DIM=$'\033[2m'; RESET=$'\033[0m'

FAKE_PID=""
cleanup() {
    if [[ -n "$FAKE_PID" ]] && kill -0 "$FAKE_PID" 2>/dev/null; then
        kill "$FAKE_PID" 2>/dev/null || true
        wait "$FAKE_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

log() { echo "${CYAN}[e2e]${RESET} $*" >&2; }
warn() { echo "${YELLOW}[e2e]${RESET} $*" >&2; }
fail() { echo "${RED}[e2e]${RESET} $*" >&2; }

# --- 1. Build billion-context-pi (dist/index.js is loaded as the extension) ---
log "building billion-context-pi..."
npm run build >/dev/null
[[ -f "$ROOT/dist/index.js" ]] || { fail "dist/index.js missing after build"; exit 1; }
[[ -x "$PI_BIN" ]] || { fail "pi binary not found at $PI_BIN (set PI_BIN)"; exit 1; }
PI_VERSION="$("$PI_BIN" --version 2>&1 | head -1 || echo unknown)"
log "pi binary: $PI_VERSION at $PI_BIN"

mkdir -p "$WORK_ROOT"

# --- helpers ---

wait_for_fake() {
    local i
    for ((i = 0; i < 50; i++)); do
        if "$NODE_BIN" -e '
            const http = require("http");
            const req = http.get("http://127.0.0.1:" + process.argv[1] + "/v1/models", (res) => {
                process.exit(res.statusCode === 200 ? 0 : 1);
            });
            req.on("error", () => process.exit(1));
            req.setTimeout(1000, () => { req.destroy(); process.exit(1); });
        ' "$FAKE_PORT" 2>/dev/null; then
            return 0
        fi
        sleep 0.2
    done
    return 1
}

# Write the isolated HOME's Pi config: models.json (fake provider) + base acp.json.
# $1 = fake home dir
write_pi_config() {
    local home="$1"
    mkdir -p "$home/.pi/agent"
    cat > "$home/.pi/agent/models.json" <<EOF
{
  "providers": {
    "fake": {
      "baseUrl": "http://127.0.0.1:${FAKE_PORT}",
      "api": "openai-completions",
      "apiKey": "fake",
      "models": [
        {
          "id": "fake-model",
          "name": "Fake E2E Model",
          "input": ["text"],
          "contextWindow": 100000,
          "maxTokens": 8192,
          "compat": { "supportsStrictTools": false }
        }
      ]
    }
  }
}
EOF
    cat > "$home/.pi/acp.json" <<'EOF'
{ "autoUpdate": false, "debug": false }
EOF
}

apply_scenario_acp_config() {
    local scenario="$1" home="$2"
    "$NODE_BIN" -e '
        const fs = require("fs");
        const home = process.argv[1];
        const scenarioPath = process.argv[2];
        const base = JSON.parse(fs.readFileSync(home + "/.pi/acp.json", "utf8"));
        const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
        const merged = Object.assign({}, base, scenario.acpConfig || {});
        fs.writeFileSync(home + "/.pi/acp.json", JSON.stringify(merged, null, 2));
    ' "$home" "$scenario"
}

user_turns() {
    local scenario="$1"
    "$NODE_BIN" -e '
        const fs = require("fs");
        const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const turns = s.turns || [];
        const out = [];
        for (let i = 0; i < turns.length; i++) {
            const t = turns[i];
            if (t.auto) continue;
            out.push(t.userText || ("Turn " + (i + 1) + ". Continue the task."));
        }
        console.log(out.join("\n"));
    ' "$scenario"
}

# --- run a single scenario ---
# $1 = scenario file path
run_scenario() {
    local scenario="$1"
    local name
    name="$(basename "$scenario" .json)"

    echo ""
    log "${YELLOW}▶ scenario: ${name}${RESET}"

    local home="$WORK_ROOT/home-$name"
    local session_dir="$WORK_ROOT/sessions-$name"
    local turn_counter="$WORK_ROOT/turn-$name"
    local observations="$WORK_ROOT/obs-$name.json"
    local pi_log="$WORK_ROOT/pi-$name.log"

    rm -rf "$home" "$session_dir"
    mkdir -p "$home" "$session_dir"
    : > "$pi_log"
    : > "$turn_counter"
    echo '{"requests":[]}' > "$observations"

    write_pi_config "$home"
    apply_scenario_acp_config "$scenario" "$home"

    SCENARIO="$scenario" \
    TURN_COUNTER="$turn_counter" \
    OBSERVATIONS="$observations" \
    PORT="$FAKE_PORT" \
    "$NODE_BIN" "$ROOT/scripts/e2e/fake-llm-server.cjs" \
        >"$WORK_ROOT/fake-$name.log" 2>&1 &
    FAKE_PID=$!
    log "fake LLM pid=$FAKE_PID (log: $WORK_ROOT/fake-$name.log)"

    if ! wait_for_fake; then
        fail "fake LLM did not become healthy; log:"
        cat "$WORK_ROOT/fake-$name.log" >&2 || true
        kill "$FAKE_PID" 2>/dev/null || true
        return 1
    fi

    local turn_no=0
    local cont_flag=""
    while IFS= read -r user_msg; do
        [[ -z "$user_msg" ]] && continue
        turn_no=$((turn_no + 1))
        log "  turn ${turn_no}: ${DIM}pi -p${RESET} ${cont_flag:-$(echo "(new session)")}"
        HOME="$home" PI_OFFLINE=1 "$PI_BIN" -p \
            --mode json \
            --provider fake --model fake/fake-model --api-key fake \
            -ne -e "$EXTENSION" \
            --session-dir "$session_dir" \
            $cont_flag \
            "$user_msg" \
            </dev/null \
            >>"$pi_log" 2>&1 || {
                fail "pi -p failed on turn ${turn_no} (see $pi_log)"
                break
            }
        cont_flag="-c"
    done < <(user_turns "$scenario")

    kill "$FAKE_PID" 2>/dev/null || true
    wait "$FAKE_PID" 2>/dev/null || true
    FAKE_PID=""

    local state_file
    state_file="$(ls -t "$session_dir"/*.acp.json 2>/dev/null | head -1 || true)"
    if [[ -z "$state_file" ]]; then
        fail "no .acp.json state file in $session_dir"
        ls -la "$session_dir" >&2 || true
        return 1
    fi
    log "  state file: ${state_file/$WORK_ROOT/\$WORK}"

    OBSERVATIONS="$observations" \
    "$NODE_BIN" "$ROOT/scripts/e2e/verify.mjs" "$state_file" "$scenario" "$session_dir"
}

# --- main ---

shopt -s nullglob
scenarios=("$ROOT/scripts/e2e/scenarios"/*.json)
shopt -u nullglob

if [[ ${#scenarios[@]} -eq 0 ]]; then
    fail "no scenarios found in scripts/e2e/scenarios/"
    exit 1
fi

total=0; passed=0; failed=0
declare -a failed_names

for scenario in "${scenarios[@]}"; do
    local_name="$(basename "$scenario")"
    if [[ -n "$SCENARIO_FILTER" ]] && [[ "$local_name" != *"$SCENARIO_FILTER"* ]]; then
        continue
    fi
    total=$((total + 1))
    if run_scenario "$scenario"; then
        passed=$((passed + 1))
        echo "${GREEN}[e2e] ✓ $(basename "$scenario" .json)${RESET}" >&2
    else
        failed=$((failed + 1))
        failed_names+=("$(basename "$scenario" .json)")
        echo "${RED}[e2e] ✗ $(basename "$scenario" .json)${RESET}" >&2
    fi
done

echo ""
log "results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${total} total"
if [[ $failed -gt 0 ]]; then
    fail "failed scenarios: ${failed_names[*]}"
    exit 1
fi
log "${GREEN}all scenarios passed${RESET}"
