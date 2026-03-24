#!/usr/bin/env bash
# AgentGuard Installer
# Usage: bash install.sh
set -e

BOLD="\033[1m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}${BOLD}║         AgentGuard Installer             ║${RESET}"
echo -e "${CYAN}${BOLD}║  Universal guardrails for AI agents      ║${RESET}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""

# ── Node.js check ────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found.${RESET}"
  echo "  Install it from https://nodejs.org (v18 or higher required)"
  exit 1
fi

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}✗ Node.js v18+ required. You have v${NODE_VERSION}.${RESET}"
  echo "  Upgrade at https://nodejs.org"
  exit 1
fi
echo -e "${GREEN}✓ Node.js v$(node --version | tr -d v) found${RESET}"

# ── npm check ────────────────────────────────────────────────────────────────
if ! command -v npm &>/dev/null; then
  echo -e "${RED}✗ npm not found. Install Node.js from https://nodejs.org${RESET}"
  exit 1
fi
echo -e "${GREEN}✓ npm $(npm --version) found${RESET}"

# ── macOS: Xcode Command Line Tools (needed for node-pty native build) ───────
if [[ "$OSTYPE" == "darwin"* ]]; then
  if ! xcode-select -p &>/dev/null; then
    echo ""
    echo -e "${YELLOW}⚠  Xcode Command Line Tools not found.${RESET}"
    echo "   Installing them now (this may take a few minutes)..."
    xcode-select --install
    echo "   Once the installer finishes, re-run this script."
    exit 0
  fi
  echo -e "${GREEN}✓ Xcode Command Line Tools found${RESET}"
fi

# ── install npm dependencies ─────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Installing dependencies...${RESET}"
npm install

# ── compile node-pty native bindings ─────────────────────────────────────────
echo ""
echo -e "${BOLD}Compiling node-pty (native PTY support)...${RESET}"
if [ -d "node_modules/node-pty" ]; then
  (cd node_modules/node-pty && npx node-gyp rebuild 2>&1) && \
    echo -e "${GREEN}✓ node-pty compiled successfully${RESET}" || \
    echo -e "${YELLOW}⚠  node-pty compile failed — will use log-based fallback mode${RESET}"
else
  echo -e "${YELLOW}⚠  node-pty not found in node_modules — skipping${RESET}"
fi

# ── npm link (makes `agentguard` available globally) ─────────────────────────
echo ""
echo -e "${BOLD}Installing agentguard globally...${RESET}"
npm link
echo -e "${GREEN}✓ agentguard installed${RESET}"

# ── verify ───────────────────────────────────────────────────────────────────
echo ""
if command -v agentguard &>/dev/null; then
  echo -e "${GREEN}${BOLD}✓ Installation complete!${RESET}"
  echo ""
  echo -e "  Run ${CYAN}agentguard --help${RESET} to get started."
  echo -e "  Read ${CYAN}TESTING.md${RESET} for test scenarios and feedback instructions."
  echo ""
else
  echo -e "${YELLOW}⚠  agentguard not found in PATH after install.${RESET}"
  echo "   Try: export PATH=\"\$PATH:\$(npm bin -g)\""
  echo "   Then run: agentguard --help"
fi
