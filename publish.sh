#!/usr/bin/env bash
# Publica a extensao no VS Code Marketplace e no Open VSX.
# Tokens sao lidos do Keychain do macOS (nada de segredo em arquivo).
#
# Salvar tokens (uma vez):
#   security add-generic-password -a "$USER" -s openvsx-token -w "TOKEN" -U
#   security add-generic-password -a "$USER" -s vsce-pat      -w "PAT"   -U
#
# Uso:
#   ./publish.sh            # sobe patch (0.1.0 -> 0.1.1) e publica nos dois
#   ./publish.sh minor      # 0.1.0 -> 0.2.0
#   ./publish.sh major      # 0.1.0 -> 1.0.0
#   ./publish.sh --no-bump  # publica a versao atual, sem incrementar
set -euo pipefail
cd "$(dirname "$0")"

BUMP="${1:-patch}"

if [ "$BUMP" != "--no-bump" ]; then
  npm version "$BUMP" --no-git-tag-version >/dev/null
fi

VERSION="$(node -p "require('./package.json').version")"
VSIX="arken-vscode-$VERSION.vsix"
echo "==> Versao $VERSION"

# le tokens do Keychain (vazio se nao existir)
OVSX_PAT="$(security find-generic-password -a "$USER" -s openvsx-token -w 2>/dev/null || true)"
VSCE_PAT="$(security find-generic-password -a "$USER" -s vsce-pat -w 2>/dev/null || true)"

echo "==> Empacotando $VSIX"
npx --yes @vscode/vsce package >/dev/null
echo "    ok: $VSIX"

if [ -n "$VSCE_PAT" ]; then
  echo "==> VS Code Marketplace"
  npx --yes @vscode/vsce publish -p "$VSCE_PAT" --packagePath "$VSIX"
else
  echo "==> VS Code Marketplace: PULADO (vsce-pat nao esta no Keychain)"
fi

if [ -n "$OVSX_PAT" ]; then
  echo "==> Open VSX"
  npx --yes ovsx publish "$VSIX" -p "$OVSX_PAT"
else
  echo "==> Open VSX: PULADO (openvsx-token nao esta no Keychain)"
fi

echo "==> Concluido: $VERSION"
