#!/usr/bin/env bash
# ============================================================
#  pi-search-boost — one-click installer (macOS / Linux)
#  Installs the extension into ~/.pi/agent/extensions/search-boost
# ============================================================
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.pi/agent/extensions/search-boost"

echo
echo "  ============================================"
echo "   pi-search-boost installer (macOS / Linux)"
echo "  ============================================"
echo "   Source : $SRC"
echo "   Target : $DEST"
echo

# ---- locate pi ----
if ! command -v pi >/dev/null 2>&1; then
    echo "  [WARN] \`pi\` not found on PATH. Install pi first:"
    echo "         https://github.com/earendil-works/pi-coding-agent"
    echo "         The extension files are still copied; enable them after pi is installed."
    echo
fi

# ---- copy files ----
mkdir -p "$DEST/lib"
cp "$SRC/index.ts" "$DEST/index.ts"
cp "$SRC"/lib/*.ts "$DEST/lib/"
echo "  [OK] Files copied."

# ---- optional env keys ----
echo
echo "  ============================================"
echo "   Optional API keys (skip all = keyless mode:"
echo "   Bing HTML + Jina Reader still work)"
echo "  ============================================"
echo

read -rp "  Tavily key (recommended, best quality) [Enter to skip]: " TAVILY
if [ -n "$TAVILY" ]; then
    if grep -q "PI_SEARCH_TAVILY_KEY" "$HOME/.bashrc" 2>/dev/null; then
        sed -i.bak "s|export PI_SEARCH_TAVILY_KEY=.*|export PI_SEARCH_TAVILY_KEY=\"$TAVILY\"|" "$HOME/.bashrc"
    else
        echo "export PI_SEARCH_TAVILY_KEY=\"$TAVILY\"" >> "$HOME/.bashrc"
    fi
    echo "  [OK] PI_SEARCH_TAVILY_KEY appended to ~/.bashrc"
fi

read -rp "  Exa key (semantic search) [Enter to skip]: " EXA
if [ -n "$EXA" ]; then
    if grep -q "PI_SEARCH_EXA_KEY" "$HOME/.bashrc" 2>/dev/null; then
        sed -i.bak "s|export PI_SEARCH_EXA_KEY=.*|export PI_SEARCH_EXA_KEY=\"$EXA\"|" "$HOME/.bashrc"
    else
        echo "export PI_SEARCH_EXA_KEY=\"$EXA\"" >> "$HOME/.bashrc"
    fi
    echo "  [OK] PI_SEARCH_EXA_KEY appended to ~/.bashrc"
fi

read -rp "  Brave key (keyword search) [Enter to skip]: " BRAVE
if [ -n "$BRAVE" ]; then
    if grep -q "PI_SEARCH_BRAVE_KEY" "$HOME/.bashrc" 2>/dev/null; then
        sed -i.bak "s|export PI_SEARCH_BRAVE_KEY=.*|export PI_SEARCH_BRAVE_KEY=\"$BRAVE\"|" "$HOME/.bashrc"
    else
        echo "export PI_SEARCH_BRAVE_KEY=\"$BRAVE\"" >> "$HOME/.bashrc"
    fi
    echo "  [OK] PI_SEARCH_BRAVE_KEY appended to ~/.bashrc"
fi

# ---- verify ----
echo
echo "  ============================================"
echo "   Verification"
echo "  ============================================"
echo "   Extension installed at: $DEST"
echo
echo "   Next steps:"
echo "     1. Restart pi (or run /reload in the TUI)"
echo "     2. Test:  pi -e $DEST/index.ts -p \"fused_search test\""
echo "     3. See README.md for tools, commands, and usage"
echo
echo "   Get free API keys:"
echo "     Tavily : https://tavily.com   (1000 free credits/mo)"
echo "     Exa    : https://exa.ai"
echo "     Brave  : https://brave.com/search/api/"
echo
echo "   Done!"
echo
