#!/usr/bin/env bash
# Doc-vs-code reconciliation gate.
#
# Extracts the canonical command surface from `crewmate --help` and the MCP
# tool surface from `src/mcp/server.ts`'s `registerTool('crewmate_*', ...)`
# calls. Fails loud if any name is missing from the user-facing docs
# (README.md, AGENTS.md, the two mesh-router.md copies).
#
# This is the gate that catches doc drift introduced by parallel-agent
# builds: if a tool ships in code without a doc mention, this script breaks.
#
# Designed to run in CI (no colors required, exits non-zero on any miss).

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$PROJECT_ROOT"

export PATH="$HOME/.bun/bin:$PATH"

# Color helpers (no-op when not a TTY)
if tty -s 2>/dev/null; then
  GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; RESET=""
fi

ok()   { printf '%s[OK]%s %s\n'   "$GREEN"  "$RESET" "$1"; }
fail() { printf '%s[FAIL]%s %s\n' "$RED"    "$RESET" "$1" >&2; }
info() { printf '%s[..]%s %s\n'   "$YELLOW" "$RESET" "$1"; }

DOCS=(
  "README.md"
  "AGENTS.md"
  "templates/mesh-router.md"
  ".claude/agents/mesh-router.md"
)

for f in "${DOCS[@]}"; do
  if [[ ! -f "$f" ]]; then
    fail "expected doc not present: $f"
    exit 1
  fi
done

# ─── 1. Bash CLI surface ────────────────────────────────────────────────────
# Extract subcommand names from `crewmate --help`. We grep lines that look
# like "  crewmate <name>" or "  crewmate <name> <subname>" (e.g. "context list").
info "extracting Bash CLI subcommands from --help"
HELP_TXT=$(bun src/cli.ts --help 2>&1)

# Top-level subcommands (single-word, e.g. init, doctor, send)
TOP_CMDS=$(printf '%s\n' "$HELP_TXT" | grep -E '^\s+crewmate [a-z][a-z-]+' \
  | awk '{print $2}' | sort -u)

# `crewmate context <subname>` family
CTX_SUBS=$(printf '%s\n' "$HELP_TXT" | grep -E '^\s+crewmate context [a-z]+' \
  | awk '{print "context "$3}' | sort -u)

ALL_CLI_SURFACE=$(printf '%s\n%s\n' "$TOP_CMDS" "$CTX_SUBS" | sort -u | grep -v '^$')

ok "$(printf '%s\n' "$ALL_CLI_SURFACE" | wc -l | tr -d ' ') CLI surface item(s) extracted"

# ─── 2. MCP tool surface ────────────────────────────────────────────────────
# Tool names are on the line AFTER `registerTool(` (multi-line registration
# style), so capture the next line and extract the quoted identifier.
info "extracting MCP tool names from src/mcp/server.ts"
MCP_TOOLS=$(grep -A1 'registerTool(' src/mcp/server.ts \
  | grep -oE "'crewmate_[a-z_]+'" | tr -d "'" | sort -u)

ok "$(printf '%s\n' "$MCP_TOOLS" | wc -l | tr -d ' ') MCP tool(s) extracted"

# ─── 3. Cross-check: every CLI subcommand is mentioned in at least one doc ──
info "checking CLI surface is documented"
CLI_MISSING=0
while IFS= read -r cmd; do
  [[ -z "$cmd" ]] && continue
  # Match `crewmate <cmd>` (simple) or `crewmate context <sub>` (compound)
  if [[ "$cmd" == context\ * ]]; then
    pattern="crewmate $cmd"
  else
    pattern="crewmate $cmd"
  fi
  found=0
  for f in "${DOCS[@]}"; do
    if grep -F -q "$pattern" "$f"; then
      found=1
      break
    fi
  done
  if [[ $found -eq 0 ]]; then
    fail "CLI surface not documented: \`$pattern\`"
    CLI_MISSING=$((CLI_MISSING + 1))
  fi
done <<< "$ALL_CLI_SURFACE"

if [[ $CLI_MISSING -eq 0 ]]; then
  ok "all CLI subcommands appear in at least one doc"
fi

# ─── 4. Cross-check: every MCP tool is mentioned in at least one doc ────────
info "checking MCP tool surface is documented"
MCP_MISSING=0
while IFS= read -r tool; do
  [[ -z "$tool" ]] && continue
  found=0
  for f in "${DOCS[@]}"; do
    if grep -F -q "$tool" "$f"; then
      found=1
      break
    fi
  done
  if [[ $found -eq 0 ]]; then
    fail "MCP tool not documented: \`$tool\`"
    MCP_MISSING=$((MCP_MISSING + 1))
  fi
done <<< "$MCP_TOOLS"

if [[ $MCP_MISSING -eq 0 ]]; then
  ok "all MCP tools appear in at least one doc"
fi

# ─── 5. Optional: check the bundled mesh-router template stays in sync ──────
info "checking templates/mesh-router.md matches .claude/agents/mesh-router.md"
if diff -q templates/mesh-router.md .claude/agents/mesh-router.md > /dev/null; then
  ok "template and project copy are byte-identical"
else
  fail "templates/mesh-router.md drifted from .claude/agents/mesh-router.md"
  diff templates/mesh-router.md .claude/agents/mesh-router.md | head -30 >&2
  exit 1
fi

# ─── Summary ────────────────────────────────────────────────────────────────
TOTAL_MISSING=$((CLI_MISSING + MCP_MISSING))
echo ""
if [[ $TOTAL_MISSING -gt 0 ]]; then
  fail "$TOTAL_MISSING surface item(s) lack doc mentions; either add a reference or remove the surface"
  exit 1
fi
printf '\n%s[OK]%s docs reconciled — %s CLI subcommands, %s MCP tools all documented\n' \
  "$GREEN" "$RESET" \
  "$(printf '%s\n' "$ALL_CLI_SURFACE" | wc -l | tr -d ' ')" \
  "$(printf '%s\n' "$MCP_TOOLS" | wc -l | tr -d ' ')"
