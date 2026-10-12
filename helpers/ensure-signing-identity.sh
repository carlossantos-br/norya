#!/bin/bash
# Creates one stable, local code-signing identity for Norya's native modules.
# The private key lives in the user's Norya data directory and is imported into
# the login keychain once. Stable identity + stable bundle IDs preserve TCC
# permissions across rebuilds without depending on an Apple developer account.
set -euo pipefail

IDENTITY="Norya Local Modules"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# Prefer an already-provisioned Apple Development identity (or the one named in
# NORYA_SIGN_IDENTITY): existing TCC grants keep their designated requirement.
APPLE_IDENTITY="${NORYA_SIGN_IDENTITY:-$(/usr/bin/security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | /usr/bin/grep -m1 -o '"Apple Development: [^"]*"' | /usr/bin/tr -d '"')}"
if [ -n "$APPLE_IDENTITY" ] && /usr/bin/security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | /usr/bin/grep -Fq "\"$APPLE_IDENTITY\""; then
  printf '%s\n' "$APPLE_IDENTITY"
  exit 0
fi

if /usr/bin/security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | /usr/bin/grep -Fq '"Norya Local Modules"'; then
  printf '%s\n' "$IDENTITY"
  exit 0
fi

if [ -n "${NORYA_HOME:-}" ]; then NORYA_DIR="$NORYA_HOME"
elif [ -d "$HOME/.norya" ]; then NORYA_DIR="$HOME/.norya"
else NORYA_DIR="$HOME/.codex-panel"; fi

SIGNING_DIR="$NORYA_DIR/signing"
KEY="$SIGNING_DIR/norya-local-modules.key.pem"
CERT="$SIGNING_DIR/norya-local-modules.cert.pem"
mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"

if [ ! -s "$KEY" ] || [ ! -s "$CERT" ]; then
  echo "→ Criando identidade local estável do Norya..." >&2
  /usr/bin/openssl req -new -newkey rsa:2048 -nodes -x509 -sha256 -days 3650 \
    -subj "/CN=$IDENTITY/O=Norya/OU=Local Modules" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=codeSigning" \
    -keyout "$KEY" -out "$CERT" >/dev/null 2>&1
  chmod 600 "$KEY" "$CERT"
fi

P12="$(/usr/bin/mktemp -t norya-signing).p12"
PASS="$(/usr/bin/openssl rand -hex 18)"
trap '/bin/rm -f "$P12"' EXIT
/usr/bin/openssl pkcs12 -export -legacy -inkey "$KEY" -in "$CERT" \
  -name "$IDENTITY" -out "$P12" -passout "pass:$PASS" >/dev/null 2>&1
/usr/bin/security import "$P12" -k "$KEYCHAIN" -P "$PASS" -A -T /usr/bin/codesign >/dev/null
/usr/bin/security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN" "$CERT" >/dev/null

if ! /usr/bin/security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | /usr/bin/grep -Fq '"Norya Local Modules"'; then
  echo "ERRO: a identidade local do Norya não ficou disponível para codesign." >&2
  exit 1
fi

printf '%s\n' "$IDENTITY"
