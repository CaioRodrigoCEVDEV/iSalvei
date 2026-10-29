#!/usr/bin/env bash
# Testes seguros do script de deploy. Não acessam produção, não reiniciam
# serviços e não alteram o repositório (exceto arquivos temporários em /tmp).
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="$ROOT/scripts/deploy.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/isalvei-deploy-test.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT

pass=0
fail=0

ok() {
  pass=$((pass + 1))
  printf 'ok - %s\n' "$1"
}

not_ok() {
  fail=$((fail + 1))
  printf 'not ok - %s\n' "$1" >&2
}

assert_eq() {
  local got="$1" expected="$2" name="$3"
  if [[ "$got" == "$expected" ]]; then
    ok "$name"
  else
    not_ok "$name (esperado='$expected', obtido='$got')"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    ok "$name"
  else
    not_ok "$name (não contém '$needle')"
  fi
}

# ---------------------------------------------------------------------------
# Sintaxe
# ---------------------------------------------------------------------------
bash -n "$DEPLOY" && ok "bash -n scripts/deploy.sh"
node --check "$ROOT/scripts/runtime-check.js" && ok "node --check runtime-check.js"
node --check "$ROOT/scripts/db-backup.js" && ok "node --check db-backup.js"
node --check "$ROOT/server.js" && ok "node --check server.js"
node --check "$ROOT/api_server.js" && ok "node --check api_server.js"

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
help_out="$(bash "$DEPLOY" --help)"
assert_contains "$help_out" "--dry-run" "--help documenta --dry-run"
assert_contains "$help_out" "--yt-dlp-only" "--help documenta --yt-dlp-only"

if bash "$DEPLOY" --opcao-inexistente >/dev/null 2>&1; then
  not_ok "opção inválida retorna código != 0"
else
  ok "opção inválida retorna código != 0"
fi

if bash "$DEPLOY" --yt-dlp-version 2026.3.17 >/dev/null 2>&1; then
  not_ok "versão fora do formato YYYY.MM.DD é rejeitada"
else
  ok "versão fora do formato YYYY.MM.DD é rejeitada"
fi

if bash "$DEPLOY" --code-only --yt-dlp-only >/dev/null 2>&1; then
  not_ok "--code-only e --yt-dlp-only são mutuamente exclusivos"
else
  ok "--code-only e --yt-dlp-only são mutuamente exclusivos"
fi

# ---------------------------------------------------------------------------
# Funções internas (source não executa main)
# ---------------------------------------------------------------------------
# shellcheck disable=SC1090
source "$DEPLOY"

assert_eq "$(normalize_version 2026.03.17)" "2026.3.17" "normalize_version remove zeros à esquerda"
assert_eq "$(normalize_version v2026.3.17)" "2026.3.17" "normalize_version remove prefixo v"

mkdir -p "$TMP/app"
cat > "$TMP/app/.env" <<'EOF'
PORT=4321
API_PORT=4322
SECRET_TOKEN=nao-deve-aparecer
EOF
APP_DIR="$TMP/app"
assert_eq "$(env_get PORT)" "4321" "env_get lê PORT"
assert_eq "$(env_get API_PORT)" "4322" "env_get lê API_PORT"

# ---------------------------------------------------------------------------
# runtime-check com binários falsos
# ---------------------------------------------------------------------------
cat > "$TMP/yt-dlp" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo "2026.03.17"; else echo ok; fi
EOF
cat > "$TMP/ffmpeg" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-version" ]]; then echo "ffmpeg version 9.9-test"; else echo ok; fi
EOF
cat > "$TMP/ffprobe" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-version" ]]; then echo "ffprobe version 9.9-test"; else echo ok; fi
EOF
chmod +x "$TMP/yt-dlp" "$TMP/ffmpeg" "$TMP/ffprobe"

runtime_out="$(APP_DIR="$TMP/app" YTDLP_PATH="$TMP/yt-dlp" FFMPEG_PATH="$TMP/ffmpeg" FFPROBE_PATH="$TMP/ffprobe" \
  node "$ROOT/scripts/runtime-check.js" --expect-ytdlp 2026.03.17)"
assert_contains "$runtime_out" '"ok":true' "runtime-check aceita versão esperada"
assert_contains "$runtime_out" '"version":"2026.03.17"' "runtime-check reporta versão do yt-dlp"

if APP_DIR="$TMP/app" YTDLP_PATH="$TMP/yt-dlp" FFMPEG_PATH="$TMP/ffmpeg" FFPROBE_PATH="$TMP/ffprobe" \
  node "$ROOT/scripts/runtime-check.js" --expect-ytdlp 1999.01.01 >/dev/null 2>&1; then
  not_ok "runtime-check falha com versão divergente"
else
  ok "runtime-check falha com versão divergente"
fi

# ---------------------------------------------------------------------------
# Versão do yt-dlp compatível com o Python do backend
# ---------------------------------------------------------------------------
mkdir -p "$TMP/py"
cat > "$TMP/py/python310" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-c" ]]; then
  echo "3.10.12"
  exit 0
fi
exit 1
EOF
chmod +x "$TMP/py/python310"

cat > "$TMP/pypi-ytdlp.json" <<'EOF'
{
  "releases": {
    "2026.10.26": [{"requires_python": ">=3.11", "yanked": false}],
    "2026.10.21": [{"requires_python": ">=3.10", "yanked": false}],
    "2026.3.17": [{"requires_python": ">=3.10", "yanked": false}],
    "2026.10.27.dev0": [{"requires_python": ">=3.11", "yanked": false}],
    "2025.1.1": [{"requires_python": ">=3.9", "yanked": true}]
  }
}
EOF

compat_out="$(
  curl() { cat "$TMP/pypi-ytdlp.json"; }
  resolve_latest_compatible_ytdlp_version "$TMP/py/python310"
)"
assert_eq "$compat_out" "2026.10.21" "escolhe yt-dlp compatível com Python 3.10"

# ---------------------------------------------------------------------------
# Detecção de systemd sem variáveis explícitas
# ---------------------------------------------------------------------------
mkdir -p "$TMP/bin" "$TMP/isalvei"
touch "$TMP/isalvei/server.js"
printf '{"name":"isalvei","scripts":{}}\n' > "$TMP/isalvei/package.json"
cat > "$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
cmd="${1:-}"
shift || true
case "$cmd" in
  list-units)
    printf '%s\n' \
      "isalvei.service loaded active running iSalvei" \
      "other.service loaded active running Unrelated"
    ;;
  list-unit-files)
    printf '%s\n' \
      "isalvei.service enabled" \
      "isalvei-api.service disabled" \
      "unrelated.service enabled"
    ;;
  show)
    key=""
    unit=""
    while (($#)); do
      case "$1" in
        -p) key="${2:-}"; shift 2 ;;
        --value) shift ;;
        *) unit="$1"; shift ;;
      esac
    done
    case "$unit:$key" in
      isalvei.service:MainPID) printf '0\n' ;;
      isalvei.service:WorkingDirectory) printf '%s\n' "$FAKE_APP_DIR" ;;
      isalvei.service:ExecStart) printf '{ path=/usr/bin/npm ; argv[]=/usr/bin/npm start ; }\n' ;;
      isalvei-api.service:MainPID) printf '0\n' ;;
      isalvei-api.service:WorkingDirectory) printf '%s\n' "$FAKE_APP_DIR" ;;
      isalvei-api.service:ExecStart) printf '{ path=/usr/bin/node ; argv[]=/usr/bin/node api_server.js ; }\n' ;;
      *) printf '\n' ;;
    esac
    ;;
  cat)
    case "${1:-}" in
      isalvei.service|isalvei-api.service) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/systemctl"

systemd_out="$(
  PATH="$TMP/bin:$PATH" FAKE_APP_DIR="$TMP/isalvei" \
    bash -c '
      source "$1"
      APP_DIR="$2"
      DEPLOY_PROCESS=server
      ENTRY_FILES=(server.js)
      detect_systemd || exit 1
      printf "%s\n" "${SYSTEMD_UNITS[@]}"
    ' _ "$DEPLOY" "$TMP/isalvei"
)"
assert_eq "$systemd_out" "isalvei.service" "detecta isalvei.service automaticamente"

systemd_both_out="$(
  PATH="$TMP/bin:$PATH" FAKE_APP_DIR="$TMP/isalvei" \
    bash -c '
      source "$1"
      APP_DIR="$2"
      DEPLOY_PROCESS=both
      ENTRY_FILES=(server.js api_server.js)
      detect_systemd || exit 1
      printf "%s\n" "${SYSTEMD_UNITS[@]}"
    ' _ "$DEPLOY" "$TMP/isalvei"
)"
assert_eq "$systemd_both_out" $'isalvei.service\nisalvei-api.service' "detecta serviço e API no modo both"

# ---------------------------------------------------------------------------
# Dry-run completo em sandbox (sem rede e sem alterar nada)
# ---------------------------------------------------------------------------
mkdir -p "$TMP/sandbox"
touch "$TMP/sandbox/server.js"
printf '{"name":"sandbox","scripts":{}}\n' > "$TMP/sandbox/package.json"
printf 'PORT=6553\n' > "$TMP/sandbox/.env"

dry_out="$(APP_DIR="$TMP/sandbox" \
  YTDLP_PATH="$TMP/yt-dlp" \
  FFMPEG_PATH="$TMP/ffmpeg" \
  FFPROBE_PATH="$TMP/ffprobe" \
  DEPLOY_YTDLP_METHOD=standalone \
  DEPLOY_METHOD=node \
  DEPLOY_SKIP_NETWORK_CHECK=1 \
  bash "$DEPLOY" --dry-run --yt-dlp-only --yt-dlp-version 2026.03.18 --no-restart 2>&1)"
assert_contains "$dry_out" "DRY-RUN" "dry-run anuncia simulação"
assert_contains "$dry_out" "Seria" "dry-run mostra etapas planejadas"
assert_contains "$dry_out" "Status:        success" "dry-run conclui com sucesso"

if [[ -e "$TMP/sandbox/.deploy" ]]; then
  not_ok "dry-run não cria .deploy"
else
  ok "dry-run não cria .deploy"
fi

# ---------------------------------------------------------------------------
# Lock: uma segunda execução não pode rodar em paralelo
# ---------------------------------------------------------------------------
mkdir -p "$TMP/locked/.deploy"
printf '{"name":"locked","scripts":{}}\n' > "$TMP/locked/package.json"
touch "$TMP/locked/server.js"
printf 'PORT=6554\n' > "$TMP/locked/.env"

lock_out="$(
  exec 8>"$TMP/locked/.deploy/deploy.lock"
  flock -n 8
  APP_DIR="$TMP/locked" \
    YTDLP_PATH="$TMP/yt-dlp" \
    FFMPEG_PATH="$TMP/ffmpeg" \
    FFPROBE_PATH="$TMP/ffprobe" \
    DEPLOY_YTDLP_METHOD=standalone \
    DEPLOY_METHOD=node \
    DEPLOY_SKIP_NETWORK_CHECK=1 \
    bash "$DEPLOY" --yt-dlp-only --yt-dlp-version 2026.03.17 --no-restart 2>&1
)" || true
if [[ "$lock_out" == *"outro deploy em execução"* ]]; then
  ok "lock impede execução simultânea"
else
  not_ok "lock impede execução simultânea"
fi

# ---------------------------------------------------------------------------
# Resumo
# ---------------------------------------------------------------------------
printf '\n%d passaram, %d falharam\n' "$pass" "$fail"
if (( fail > 0 )); then
  exit 1
fi
