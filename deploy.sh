#!/bin/bash
set -e

# Instala o bundle sem encerrar tasks; o novo código entra no próximo launch.
NORYA_RESTART=1
case "${1:-}" in
  "") ;;
  --no-restart) NORYA_RESTART=0 ;;
  *) echo "Uso: bash deploy.sh [--no-restart]" >&2; exit 2 ;;
esac

# Mesmo resolvedor do app: ~/.norya (canônico) antes de ~/.codex-panel (legado).
if [ -n "$NORYA_HOME" ]; then NORYA_DIR="$NORYA_HOME"
elif [ -d "$HOME/.norya" ]; then NORYA_DIR="$HOME/.norya"
else NORYA_DIR="$HOME/.codex-panel"; fi
SRC="$NORYA_DIR/app"
APP="/Applications/Norya.app/Contents/Resources/app"

if [ "$NORYA_RESTART" = 1 ]; then
echo "→ Encerrando Norya..."
# Nome antigo "Painel Operacional" foi renomeado pra Norya em 22 mai (ba14768).
# Mantemos ambos por compat. Sem isso, deploy copia arquivos mas o processo
# em memória continua com o código antigo.
pkill -9 -f "Painel Operacional" 2>/dev/null || true
pkill -9 -f "/Applications/Norya.app/Contents/MacOS/Norya" 2>/dev/null || true
sleep 0.8
else
  echo "→ Preservando sessões abertas (aplicar no próximo launch)..."
fi

echo "→ Copiando arquivos..."

# Poda de órfãos: deploy.sh copia por allowlist e NUNCA remove. Sem isto, um
# arquivo deletado do fonte sobrevive no bundle e pode ser carregado por um
# require() antigo. Adicionado 2026-07-09 com a poda da Fase 1.
echo "→ Removendo órfãos do bundle..."
for f in norya-pip.html norya-pip-mini.html browser-preload.js aider-bridge.py; do
  [ -e "$APP/$f" ] && rm -f "$APP/$f" && echo "  ✗ $f"
done
for d in mobile bin/tor; do
  [ -d "$APP/$d" ] && rm -rf "${APP:?}/${d:?}" && echo "  ✗ $d/"
done
for f in tor-manager privacy-hardener password-vault extension-loader; do
  [ -e "$APP/browser/$f.js" ] && rm -f "$APP/browser/$f.js" && echo "  ✗ browser/$f.js"
done
# platform.js (2026-09-01, port Windows): o main.js faz `require('./platform')`
# LOGO no topo. Esquecê-lo aqui não dá erro de deploy — dá tela preta no boot.
# ui-prefs.js (2026-09-08): mesma armadilha. É require do main.js E do <head>
# de test-window.html (decide o vidro antes do 1º paint). test/deploy-allowlist
# pega esse esquecimento — foi ele que pegou este.
for f in main.js test-window.html norya-home.js claude-meta.js platform.js ui-prefs.js token-stats.js pricing.js fx.js; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$APP/$f"
    echo "  ✓ $f"
  fi
done

# badge-icon.js: gerador do overlay da taskbar (Windows). No macOS não é usado,
# mas o main.js o REQUER no topo — sem ele o app não sobe nem aqui.
mkdir -p "$APP/helpers"
cp "$SRC/helpers/badge-icon.js" "$APP/helpers/badge-icon.js"
# Hook do Claude Code que avisa fim de turno ao Norya (o main o passa por
# `claude --settings`). Sem ele os panes de Claude ficam sem som de turno.
cp "$SRC/helpers/norya-claude-event.js" "$APP/helpers/norya-claude-event.js"

# Norya · Voz e Norya · Captura foram removidos em 2026-10-04. Desliga os
# LaunchAgents de instalações antigas e poda os .app/manager do bundle.
for label in ai.norya.speech ai.norya.shot; do
  /bin/launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  if [ -e "$HOME/Library/LaunchAgents/$label.plist" ]; then
    rm -f "$HOME/Library/LaunchAgents/$label.plist" && echo "  ✗ LaunchAgent $label"
  fi
done
for f in helpers/runtime/NoryaSpeech.app helpers/runtime/NoryaShot.app helpers/native-tools.js; do
  [ -e "$APP/$f" ] && rm -rf "${APP:?}/${f:?}" && echo "  ✗ $f"
done
# Norya Remote (celular + tela do Mac) removido em 2026-10-10.
for f in remote helpers/runtime/norya-remote; do
  [ -e "$APP/$f" ] && rm -rf "${APP:?}/${f:?}" && echo "  ✗ $f"
done

# Norya Browser subsystem: module dir (browser/) + helper/binary dir (bin/).
# Added 2026-05-28. Without copying them the bundled main.js `require('./browser/...')`
# calls throw at boot (no icon, no login-browser prompt). test/ excluded to keep bundle lean.
echo "→ Copiando browser/ (módulos do navegador)..."
if [ -d "$SRC/browser" ]; then
  mkdir -p "$APP/browser"
  rsync -a --delete --exclude 'test/' "$SRC/browser/" "$APP/browser/" 2>/dev/null \
    || cp -R "$SRC/browser/." "$APP/browser/"
  echo "  ✓ browser/"
fi

echo "→ Copiando bin/ (helpers MCP/auth)..."
if [ -d "$SRC/bin" ]; then
  mkdir -p "$APP/bin"
  rsync -a "$SRC/bin/" "$APP/bin/" 2>/dev/null || cp -R "$SRC/bin/." "$APP/bin/"
  chmod +x "$APP/bin/norya-auth-open" "$APP/bin/norya-browser" "$APP/bin/norya-browser-mcp.js" 2>/dev/null || true
  # O shim de `open` PRECISA ser executável: ele é resolvido pelo PATH dentro dos
  # PTYs. Sem o bit +x, todo `open <url>` da CLI falha silenciosamente.
  chmod +x "$APP/bin/open-shim/open" "$APP/bin/open-shim/xdg-open" 2>/dev/null || true
  echo "  ✓ bin/"
fi

# Deps novas de runtime: o bundle tem node_modules PRÓPRIO (congelado no
# empacotamento original) — um require() de pacote instalado só no fonte explode
# apenas no app empacotado. Adicionado 2026-07-15 com o @xterm/addon-search.
echo "→ Copiando deps de runtime novas..."
for m in "@xterm/addon-search"; do
  if [ -d "$SRC/node_modules/$m" ]; then
    mkdir -p "$APP/node_modules/$m"
    rsync -a --delete "$SRC/node_modules/$m/" "$APP/node_modules/$m/"
    echo "  ✓ node_modules/$m"
  fi
done

# Registry de agentes (agents/). Adicionado 2026-07-09. Mesmo gotcha do renderer:
# dir novo fora da allowlist → `require('./agents/registry')` explode no boot.
echo "→ Copiando agents/ (registry de CLIs)..."
if [ -d "$SRC/agents" ]; then
  mkdir -p "$APP/agents"
  rsync -a --delete "$SRC/agents/" "$APP/agents/" 2>/dev/null || cp -R "$SRC/agents/." "$APP/agents/"
  echo "  ✓ agents/"
fi

# Pane em modo chat (chat/). Adicionado 2026-10-11. Fora da allowlist, o
# require('./chat/chat-session') explode no boot do main.
echo "→ Copiando chat/ (pane em modo chat)..."
if [ -d "$SRC/chat" ]; then
  mkdir -p "$APP/chat"
  rsync -a --delete "$SRC/chat/" "$APP/chat/" 2>/dev/null || cp -R "$SRC/chat/." "$APP/chat/"
  echo "  ✓ chat/"
fi

# Renderer modular (renderer/). Adicionado 2026-07-09 na Fase 2.
# GOTCHA: deploy.sh copia por allowlist. Um diretório novo que não seja listado
# aqui faz o bundle rodar o renderer ANTIGO, sem erro nenhum — o sintoma é
# "mudei o código e nada aconteceu".
echo "→ Copiando renderer/ (módulos do renderer)..."
if [ -d "$SRC/renderer" ]; then
  mkdir -p "$APP/renderer"
  rsync -a --delete "$SRC/renderer/" "$APP/renderer/" 2>/dev/null || cp -R "$SRC/renderer/." "$APP/renderer/"
  echo "  ✓ renderer/"
fi

# Mascote flutuante (pet/ + helper Swift). Mesmo gotcha da allowlist: sem o
# pet/ o require falha no boot e o mascote some calado (setupPet não roda).
echo "→ Copiando pet/ (mascote)..."
if [ -d "$SRC/pet" ]; then
  mkdir -p "$APP/pet"
  rsync -a --delete "$SRC/pet/" "$APP/pet/" 2>/dev/null || cp -R "$SRC/pet/." "$APP/pet/"
  echo "  ✓ pet/"
fi
if [ -f "$SRC/helpers/norya-pet/build.sh" ]; then
  bash "$SRC/helpers/norya-pet/build.sh"
  mkdir -p "$APP/helpers/runtime"
  cp "$SRC/helpers/norya-pet/build/norya-pet" "$APP/helpers/runtime/norya-pet"
  chmod 755 "$APP/helpers/runtime/norya-pet"
  echo "  ✓ helpers/runtime/norya-pet"
fi

# Real-time quota subsystem (app/quota/). Added 2026-05-28.
echo "→ Copiando quota/ (quota em tempo real)..."
if [ -d "$SRC/quota" ]; then
  mkdir -p "$APP/quota"
  rsync -a --delete --exclude 'test/' "$SRC/quota/" "$APP/quota/" 2>/dev/null \
    || cp -R "$SRC/quota/." "$APP/quota/"
  echo "  ✓ quota/"
fi

echo "→ Copiando branding..."
if [ -d "$SRC/branding" ]; then
  mkdir -p "$APP/branding"
  cp -R "$SRC/branding/." "$APP/branding/"
  echo "  ✓ branding/"
fi

echo "→ Copiando assets..."
if [ -d "$SRC/assets" ]; then
  mkdir -p "$APP/assets"
  cp -R "$SRC/assets/." "$APP/assets/"
  echo "  ✓ assets/"
fi

# Refresh the app icon if a new .icns is in branding/
if [ -f "$SRC/branding/norya.icns" ]; then
  cp "$SRC/branding/norya.icns" "/Applications/Norya.app/Contents/Resources/norya.icns"
  cp "$SRC/branding/norya.icns" "/Applications/Norya.app/Contents/Resources/electron.icns"
  touch /Applications/Norya.app
fi

# Assinatura estável (2026-07-15): o macOS amarra grants TCC ao code signature.
# Adhoc-signed, o cdhash muda a cada rebuild e TODO grant evapora (sintoma:
# EPERM em ~/Documents dentro do Norya com a caixinha marcada nos Ajustes).
# Com identidade estável, os grants sobrevivem a deploys. Custo único já pago
# em 2026-07-15 (primeira execução assinada = reconceder grants 1 vez).
#
# NÃO usar `codesign --deep`: ele engasgava nos frameworks ("bundle format is
# ambiguous") porque o empacotamento original havia ACHATADO os symlinks dos
# .framework em cópias reais (3× o payload; consertado em 2026-07-15 — root
# agora é symlink → Versions/A, app caiu de ~1,1GB pra 345MB). A rotina
# correta assina DE DENTRO PRA FORA e é idempotente (~15s).
echo "→ Assinando bundle..."
SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null | grep -m1 -o '"Apple Development: [^"]*"' | tr -d '"')
if [ -n "$SIGN_ID" ]; then
  NAPP=/Applications/Norya.app
  NFW="$NAPP/Contents/Frameworks"
  EFA="$NFW/Electron Framework.framework/Versions/A"
  find "$EFA/Libraries" -name "*.dylib" -exec codesign --force --sign "$SIGN_ID" {} \; 2>/dev/null
  find "$EFA/Helpers" -type f -perm +111 -exec codesign --force --sign "$SIGN_ID" {} \; 2>/dev/null
  codesign --force --sign "$SIGN_ID" "$EFA" 2>/dev/null
  for fw in Mantle ReactiveObjC Squirrel; do
    find "$NFW/$fw.framework/Versions/A" -type f -perm +111 -not -name "$fw" \
      -exec codesign --force --sign "$SIGN_ID" {} \; 2>/dev/null
    codesign --force --sign "$SIGN_ID" "$NFW/$fw.framework/Versions/A" 2>/dev/null
  done
  for h in "$NFW"/*.app; do codesign --force --sign "$SIGN_ID" "$h" 2>/dev/null; done
  codesign --force --sign "$SIGN_ID" "$NAPP" 2>/dev/null
  if codesign --verify --deep --strict "$NAPP" 2>/dev/null; then
    echo "  ✓ assinado e verificado: $SIGN_ID"
  else
    echo "  ⚠ verificação falhou — app pode estar com seal quebrado; investigar antes de confiar em grants TCC"
  fi
else
  echo "  ⚠ nenhuma identidade 'Apple Development' no Keychain — seguindo adhoc"
fi

if [ "$NORYA_RESTART" = 1 ]; then
  echo "→ Abrindo app..."
  open "/Applications/Norya.app"
else
  echo "→ Bundle instalado. Feche e abra o Norya para aplicar."
fi

echo "✓ Deploy concluído."
