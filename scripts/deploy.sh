#!/usr/bin/env bash
# =============================================================================
# iSalvei - deploy automatizado para produção
#
# Uso principal:
#   ./scripts/deploy.sh --dry-run
#   ./scripts/deploy.sh
#   ./scripts/deploy.sh --yt-dlp-only
#   ./scripts/deploy.sh --yt-dlp-version 2026.03.17
#   ./scripts/deploy.sh --code-only
#
# O script detecta o mecanismo real (systemd, PM2, Docker ou Node direto),
# atualiza o yt-dlp no ambiente em que o backend realmente o executa e
# executa health checks. Veja docs/DEPLOY.md.
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# -----------------------------------------------------------------------------
# Defaults / configuração
# -----------------------------------------------------------------------------
APP_DIR="${APP_DIR:-$DEFAULT_APP_DIR}"
DEPLOY_METHOD="${DEPLOY_METHOD:-auto}"                 # auto|systemd|pm2|docker|node
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
DEPLOY_PROCESS="${DEPLOY_PROCESS:-server}"             # server|api|both
DEPLOY_MODE="full"                                     # full|code|ytdlp
DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-$APP_DIR/.deploy}"
DEPLOY_BACKUP_KEEP="${DEPLOY_BACKUP_KEEP:-5}"
DEPLOY_MIN_DISK_MB="${DEPLOY_MIN_DISK_MB:-2048}"
DEPLOY_HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-90}"
DEPLOY_PROCESS_WAIT="${DEPLOY_PROCESS_WAIT:-30}"
DEPLOY_NPM_FLAGS="${DEPLOY_NPM_FLAGS:-}"
DEPLOY_RUN_TESTS="${DEPLOY_RUN_TESTS:-1}"
DEPLOY_SKIP_NPM="${DEPLOY_SKIP_NPM:-0}"
DEPLOY_ALLOW_DIRTY="${DEPLOY_ALLOW_DIRTY:-0}"
DEPLOY_ROLLBACK="${DEPLOY_ROLLBACK:-1}"
DEPLOY_USE_SUDO="${DEPLOY_USE_SUDO:-auto}"             # auto|1|0
DEPLOY_SKIP_NETWORK_CHECK="${DEPLOY_SKIP_NETWORK_CHECK:-0}"
DEPLOY_YTDLP_METHOD="${DEPLOY_YTDLP_METHOD:-auto}"     # auto|pipx|venv|pip|apt|standalone
REQUESTED_YTDLP_VERSION="${DEPLOY_YTDLP_VERSION:-${YTDLP_VERSION:-}}"
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-}"

# systemd / PM2 / Docker
DEPLOY_SYSTEMD_SERVICES="${DEPLOY_SYSTEMD_SERVICES:-}"
DEPLOY_PM2_APPS="${DEPLOY_PM2_APPS:-}"
DEPLOY_DOCKER_CONTAINER="${DEPLOY_DOCKER_CONTAINER:-}"
DEPLOY_DOCKER_IMAGE="${DEPLOY_DOCKER_IMAGE:-isalvei}"
DEPLOY_DOCKER_PORTS="${DEPLOY_DOCKER_PORTS:-}"
DEPLOY_DOCKER_VOLUMES="${DEPLOY_DOCKER_VOLUMES:-}"
DEPLOY_DOCKER_RUN_ARGS="${DEPLOY_DOCKER_RUN_ARGS:-}"
DEPLOY_DOCKER_CMD="${DEPLOY_DOCKER_CMD:-}"
DEPLOY_DOCKER_PULL="${DEPLOY_DOCKER_PULL:-0}"

# Runtime / estado
METHOD=""
DRY_RUN=0
NO_RESTART=0
ASSUME_YES=0
EXIT_HANDLED=0
DEPLOY_OK=0
DEPLOY_STARTED=0
REPORT_WRITTEN=0
ERROR_STATUS=0
ERROR_LINE=0
ERROR_STEP=""
CURRENT_STEP="inicialização"
ROLLBACK_ATTEMPTED=0
ROLLBACK_RESULT="não necessário"
IN_ROLLBACK=0
INTERRUPTED=0

START_EPOCH="$(date +%s)"
START_ISO="$(date -Is)"
SECONDS=0

COMMIT_BEFORE=""
COMMIT_AFTER=""
CODE_CHANGED=0
CODE_CHANGED_PLANNED=0
DEPS_CHANGED=0
RESTART_REQUIRED=0
RESTART_STARTED=0
YTDLP_UPDATE_ATTEMPTED=0
YTDLP_UPDATED=0
YTDLP_OLD_VERSION=""
YTDLP_NEW_VERSION=""
YTDLP_TARGET_VERSION=""
YTDLP_METHOD="auto"
YTDLP_METHOD_RESULT="unknown"
YTDLP_CONFIGURED=""
YTDLP_BIN=""
YTDLP_PYTHON=""
YTDLP_APT_OLD_VERSION=""
FFMPEG_CONFIGURED=""
FFMPEG_BIN=""
FFMPEG_VERSION=""
FFPROBE_CONFIGURED=""
FFPROBE_BIN=""
FFPROBE_VERSION=""
NODE_VERSION=""
RUNTIME_PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"
SERVICE_PID=""

BACKUP_ROOT="$DEPLOY_STATE_DIR/backups"
REPORT_DIR="$DEPLOY_STATE_DIR/reports"
LOG_DIR="$DEPLOY_STATE_DIR/logs"
BACKUP_DIR=""
LOG_FILE=""
WORK_TMP=""
HEALTH_URLS=()
SYSTEMD_UNITS=()
SYSTEMD_ENTRIES=()
PM2_APPS=()
PM2_ENTRIES=()
DIRECT_PIDS=()
DIRECT_ENTRIES=()
DIRECT_LOG_OFFSETS=()
ENTRY_FILES=()

SUDO=()
DOCKER=()
DOCKER_CONTAINER=""
DOCKER_CONTAINER_EXISTS=0
DOCKER_OLD_IMAGE_ID=""
DOCKER_OLD_IMAGE_REF=""
DOCKER_OLD_IMAGE_BACKUP=""
DOCKER_NEW_IMAGE=""
DOCKER_NEW_IMAGE_ID=""
DOCKER_CONTAINER_PORT=""
DOCKER_HOST_PORT=""
DOCKER_OLD_CONTAINER_RENAMED=""
DOCKER_OLD_CONTAINER_EXISTED=0
DOCKER_OLD_CONTAINER_STOPPED=0
DOCKER_NEW_CONTAINER_STARTED=0
DOCKER_ENV_FILE=""
DOCKER_INSPECT_FILE=""

# -----------------------------------------------------------------------------
# Logging e erros
# -----------------------------------------------------------------------------
log() { printf '[deploy %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
log_step() { CURRENT_STEP="$*"; log "==> $*"; }
log_warn() { printf '[deploy %s][AVISO] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
log_error() { printf '[deploy %s][ERRO] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }

die() {
  ERROR_STEP="${ERROR_STEP:-$CURRENT_STEP}"
  log_error "$*"
  exit 1
}

on_err() {
  local status="$1" line="$2"
  trap - ERR
  ERROR_STATUS="$status"
  ERROR_LINE="$line"
  ERROR_STEP="${ERROR_STEP:-$CURRENT_STEP}"
  log_error "Falha (código $status) na linha $line durante: $CURRENT_STEP"
  exit "$status"
}

on_exit() {
  local status="$?"
  trap - EXIT INT TERM
  if [[ "$EXIT_HANDLED" -eq 1 ]]; then
    return
  fi
  EXIT_HANDLED=1

  if [[ "$DEPLOY_OK" -ne 1 && "$INTERRUPTED" -eq 1 ]]; then
    log_warn "Deploy interrompido por sinal."
  fi

  # Só tenta rollback se algo já foi alterado.
  if [[ "$DEPLOY_OK" -ne 1 && "$DEPLOY_STARTED" -eq 1 && "$DEPLOY_ROLLBACK" -eq 1 && "$ROLLBACK_ATTEMPTED" -eq 0 ]]; then
    attempt_rollback
  fi

  if [[ "$DEPLOY_OK" -eq 1 ]]; then
    write_report "success"
    print_summary "success"
  else
    write_report "failed"
    print_summary "failed"
    print_recovery_instructions
  fi

  if [[ -n "$WORK_TMP" && -d "$WORK_TMP" ]]; then
    rm -rf -- "$WORK_TMP"
  fi

  exit "$status"
}

interrupt_handler() {
  INTERRUPTED=1
  log_warn "Sinal recebido. Encerrando com rollback (se aplicável)..."
  exit 130
}

# -----------------------------------------------------------------------------
# Utilidades
# -----------------------------------------------------------------------------
usage() {
  cat <<'EOF'
iSalvei deploy

Uso:
  scripts/deploy.sh [opções]

Opções:
  --dry-run                 Mostra o plano e não altera código, dependências ou serviços.
  --method MÉTODO           auto|systemd|pm2|docker|node (padrão: auto)
  --branch BRANCH           Branch de produção (padrão: main)
  --remote REMOTE           Remote Git (padrão: origin)
  --process PROCESSO        server|api|both (padrão: server)
  --code-only               Atualiza somente o código; não altera o yt-dlp.
  --yt-dlp-only             Atualiza somente o yt-dlp; não atualiza código nem npm.
  --yt-dlp-version VERSAO   Fixa a versão do yt-dlp (ex.: 2026.03.17).
  --skip-tests              Não executa npm test.
  --skip-npm                Não executa npm ci (use com cautela).
  --no-restart              Não reinicia (apenas yt-dlp-only fora do Docker).
  --no-rollback             Desabilita rollback automático em caso de falha.
  --allow-dirty             Permite continuar com alterações locais rastreadas.
  --yes                     Não pede confirmação (deploy não interativo).
  -h, --help                Mostra esta ajuda.

Variáveis principais:
  APP_DIR, DEPLOY_METHOD, DEPLOY_BRANCH, DEPLOY_PROCESS,
  DEPLOY_SYSTEMD_SERVICES, DEPLOY_PM2_APPS, DEPLOY_DOCKER_CONTAINER,
  DEPLOY_YTDLP_VERSION, DEPLOY_YTDLP_METHOD, DEPLOY_HEALTH_URL,
  DEPLOY_HEALTH_TIMEOUT, DEPLOY_STATE_DIR, DEPLOY_BACKUP_KEEP.

Consulte docs/DEPLOY.md para detalhes, permissões e rollback.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --method)
        [[ $# -ge 2 ]] || die "--method exige um valor"
        DEPLOY_METHOD="$2"; shift ;;
      --method=*) DEPLOY_METHOD="${1#*=}" ;;
      --branch)
        [[ $# -ge 2 ]] || die "--branch exige um valor"
        DEPLOY_BRANCH="$2"; shift ;;
      --branch=*) DEPLOY_BRANCH="${1#*=}" ;;
      --remote)
        [[ $# -ge 2 ]] || die "--remote exige um valor"
        DEPLOY_REMOTE="$2"; shift ;;
      --remote=*) DEPLOY_REMOTE="${1#*=}" ;;
      --process)
        [[ $# -ge 2 ]] || die "--process exige um valor"
        DEPLOY_PROCESS="$2"; shift ;;
      --process=*) DEPLOY_PROCESS="${1#*=}" ;;
      --code-only)
        [[ "$DEPLOY_MODE" == "full" ]] || die "--code-only e --yt-dlp-only são mutuamente exclusivos"
        DEPLOY_MODE="code" ;;
      --yt-dlp-only)
        [[ "$DEPLOY_MODE" == "full" ]] || die "--code-only e --yt-dlp-only são mutuamente exclusivos"
        DEPLOY_MODE="ytdlp" ;;
      --yt-dlp-version)
        [[ $# -ge 2 ]] || die "--yt-dlp-version exige um valor"
        REQUESTED_YTDLP_VERSION="$2"; shift ;;
      --yt-dlp-version=*) REQUESTED_YTDLP_VERSION="${1#*=}" ;;
      --skip-tests) DEPLOY_RUN_TESTS=0 ;;
      --skip-npm) DEPLOY_SKIP_NPM=1 ;;
      --no-restart) NO_RESTART=1 ;;
      --no-rollback) DEPLOY_ROLLBACK=0 ;;
      --allow-dirty) DEPLOY_ALLOW_DIRTY=1 ;;
      --yes|-y) ASSUME_YES=1 ;;
      --help|-h) usage; exit 0 ;;
      *) die "Opção desconhecida: $1 (use --help)" ;;
    esac
    shift
  done

  case "$DEPLOY_METHOD" in
    auto|systemd|pm2|docker|node) ;;
    *) die "DEPLOY_METHOD inválido: $DEPLOY_METHOD" ;;
  esac
  case "$DEPLOY_PROCESS" in
    server|api|both) ;;
    *) die "DEPLOY_PROCESS inválido: $DEPLOY_PROCESS (server|api|both)" ;;
  esac
  case "$DEPLOY_YTDLP_METHOD" in
    auto|pipx|venv|pip|apt|standalone) ;;
    *) die "DEPLOY_YTDLP_METHOD inválido: $DEPLOY_YTDLP_METHOD" ;;
  esac
  case "$DEPLOY_USE_SUDO" in
    auto|0|1) ;;
    *) die "DEPLOY_USE_SUDO inválido: $DEPLOY_USE_SUDO" ;;
  esac

  if [[ -n "$REQUESTED_YTDLP_VERSION" ]]; then
    validate_version_format "$REQUESTED_YTDLP_VERSION" || die "Versão de yt-dlp inválida: $REQUESTED_YTDLP_VERSION (esperado YYYY.MM.DD)"
  fi
  if [[ "$DEPLOY_MODE" == "ytdlp" && "$DEPLOY_METHOD" == "docker" && "$NO_RESTART" -eq 1 ]]; then
    die "--no-restart não é suportado no modo Docker (é necessário recriar o container)"
  fi
  if [[ "$DEPLOY_MODE" == "code" && "$NO_RESTART" -eq 1 ]]; then
    die "--no-restart não é permitido quando o código é atualizado"
  fi
  if [[ "$DEPLOY_MODE" == "ytdlp" && "$DEPLOY_PROCESS" == "both" && "$DEPLOY_METHOD" != "docker" ]]; then
    log_warn "yt-dlp-only com --process both: o mesmo yt-dlp é compartilhado; não haverá restart."
  fi
}

validate_version_format() {
  [[ "$1" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$ ]]
}

normalize_version() {
  local v="${1#v}"
  printf '%s\n' "$v" | awk -F. '{
    out="";
    for (i=1; i<=NF; i++) {
      n=$i+0;
      out=out (i>1?".":"") n;
    }
    print out;
  }'
}

json_escape() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

json_field() {
  local field="$1"
  node -e '
    let data="";
    process.stdin.on("data", d => data += d);
    process.stdin.on("end", () => {
      try {
        const obj = JSON.parse(data);
        const parts = process.argv[1].split(".");
        let cur = obj;
        for (const p of parts) cur = cur == null ? undefined : cur[p];
        if (cur !== undefined && cur !== null) process.stdout.write(String(cur));
      } catch (_) { process.exit(1); }
    });
  ' "$field"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Dependência ausente: $1"
}

check_node_version() {
  local major required=18 engine=""
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$major" =~ ^[0-9]+$ ]] || die "Não foi possível determinar a versão do Node.js"

  if [[ -f "$APP_DIR/package.json" ]]; then
    engine="$(node -p 'require(process.argv[1]).engines && require(process.argv[1]).engines.node || ""' "$APP_DIR/package.json" 2>/dev/null || true)"
  fi
  if [[ "$engine" =~ \>=?[[:space:]]*([0-9]+) ]]; then
    required="${BASH_REMATCH[1]}"
  fi
  if (( major < required )); then
    die "Node.js >= $required é obrigatório pelo package.json (encontrado $(node -v))."
  fi
  NODE_VERSION="$(node -v)"
}

setup_sudo() {
  SUDO=()
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    return 0
  fi
  case "$DEPLOY_USE_SUDO" in
    0) return 0 ;;
    auto|1)
      if sudo -n true 2>/dev/null; then
        SUDO=(sudo -n)
      elif [[ "$DEPLOY_USE_SUDO" == "1" ]]; then
        die "DEPLOY_USE_SUDO=1, mas sudo sem senha não está disponível."
      fi
      ;;
  esac
}

run_privileged() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif [[ "${#SUDO[@]}" -gt 0 ]]; then
    "${SUDO[@]}" "$@"
  else
    die "Permissão de root/sudo necessária para: $*"
  fi
}

setup_docker_cmd() {
  DOCKER=(docker)
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  if [[ "${#SUDO[@]}" -gt 0 ]] && "${SUDO[@]}" docker info >/dev/null 2>&1; then
    DOCKER=("${SUDO[@]}" docker)
    return 0
  fi
  die "Sem acesso ao Docker (adicione o usuário ao grupo docker ou configure sudo sem senha)."
}

env_get() {
  local key="$1" file="${2:-$APP_DIR/.env}"
  [[ -r "$file" ]] || return 0
  awk -v key="$key" '
    {
      line=$0
      if (line ~ /^[[:space:]]*#/) next
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      if (index(line, key "=") == 1) {
        val=substr(line, length(key)+2)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
        if ((val ~ /^".*"$/) || (val ~ /^\047.*\047$/)) {
          val=substr(val, 2, length(val)-2)
        }
        print val
        exit
      }
    }
  ' "$file"
}

proc_env() {
  local pid="$1" key="$2"
  [[ -r "/proc/$pid/environ" ]] || return 0
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | awk -v k="$key" '
    index($0, k "=") == 1 { print substr($0, length(k)+2); exit }
  '
}

proc_cwd() {
  readlink "/proc/$1/cwd" 2>/dev/null || true
}

proc_cmdline() {
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || true
}

# Evita que "server.js" case com "api_server.js" por substring.
string_has_entry() {
  local haystack="$1" entry="$2" escaped
  escaped="${entry//./\\.}"
  [[ "$haystack" =~ (^|[^[:alnum:]_.-])${escaped}([^[:alnum:]_.-]|$) ]]
}

systemd_env_value() {
  local unit="$1" key="$2" envs
  envs="$(systemctl show -p Environment --value "$unit" 2>/dev/null || true)"
  printf '%s\n' "$envs" | tr ' ' '\n' | awk -v k="$key" '
    index($0, k "=") == 1 {
      v=substr($0, length(k)+2)
      gsub(/^"|"$/, "", v)
      print v
      exit
    }
  '
}

runtime_env_get() {
  local key="$1" value=""
  if [[ -n "${SERVICE_PID:-}" ]]; then
    value="$(proc_env "$SERVICE_PID" "$key" || true)"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  fi
  # Sem processo de serviço, respeita o ambiente do shell (o dotenv do app
  # também não sobrescreve variáveis já definidas).
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return 0
  fi
  env_get "$key"
}

resolve_bin() {
  local configured="$1" search_path="${2:-$RUNTIME_PATH}"
  [[ -n "$configured" ]] || return 1

  if [[ "$configured" == */* ]]; then
    [[ "$configured" = /* ]] || configured="$APP_DIR/$configured"
    realpath -m -- "$configured" 2>/dev/null || printf '%s\n' "$configured"
    return 0
  fi

  local old_path="$PATH" out=""
  PATH="$search_path"
  out="$(command -v -- "$configured" 2>/dev/null || true)"
  PATH="$old_path"
  [[ -n "$out" ]] || return 1
  realpath -m -- "$out" 2>/dev/null || printf '%s\n' "$out"
}

# -----------------------------------------------------------------------------
# Inicialização, lock e pré-requisitos
# -----------------------------------------------------------------------------
init_paths() {
  [[ -d "$APP_DIR" ]] || die "APP_DIR não existe: $APP_DIR"
  APP_DIR="$(cd -- "$APP_DIR" && pwd)"
  BACKUP_ROOT="$DEPLOY_STATE_DIR/backups"
  REPORT_DIR="$DEPLOY_STATE_DIR/reports"
  LOG_DIR="$DEPLOY_STATE_DIR/logs"

  [[ -f "$APP_DIR/package.json" ]] || die "package.json não encontrado em $APP_DIR. Execute o script no repositório iSalvei."
  [[ -f "$APP_DIR/server.js" ]] || die "server.js não encontrado em $APP_DIR."

  case "$DEPLOY_PROCESS" in
    server) ENTRY_FILES=(server.js) ;;
    api) ENTRY_FILES=(api_server.js) ;;
    both) ENTRY_FILES=(server.js api_server.js) ;;
  esac

  if [[ -d "$APP_DIR/.git" ]]; then
    COMMIT_BEFORE="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
    COMMIT_AFTER="$COMMIT_BEFORE"
  fi
}

acquire_lock() {
  mkdir -p "$DEPLOY_STATE_DIR" "$BACKUP_ROOT" "$REPORT_DIR" "$LOG_DIR"
  [[ -w "$DEPLOY_STATE_DIR" ]] || die "Sem permissão de escrita em $DEPLOY_STATE_DIR"
  exec 9>"$DEPLOY_STATE_DIR/deploy.lock"
  if ! flock -n 9; then
    die "Já existe outro deploy em execução (lock: $DEPLOY_STATE_DIR/deploy.lock)."
  fi
}

setup_logging() {
  LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"
  : > "$LOG_FILE"
  exec > >(tee -a "$LOG_FILE") 2>&1
  log "Log deste deploy: $LOG_FILE"
}

preflight_common() {
  log_step "Verificando dependências e ambiente"
  require_cmd node
  if [[ "$DEPLOY_MODE" != "ytdlp" ]]; then
    require_cmd git
    require_cmd npm
    require_cmd comm
  fi
  require_cmd curl
  require_cmd flock
  require_cmd realpath
  require_cmd tar
  require_cmd sha256sum
  require_cmd awk
  require_cmd sed
  require_cmd grep
  require_cmd df
  require_cmd stat
  check_node_version

  [[ -w "$APP_DIR" ]] || die "Sem permissão de escrita em $APP_DIR (execute como o usuário dono da aplicação)."
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    log_warn "Executando como root. Prefira o usuário da aplicação para evitar arquivos com dono root."
  fi

  local disk_mb
  disk_mb="$(df -Pk "$APP_DIR" | awk 'NR==2 {print $4}')"
  if [[ "$disk_mb" =~ ^[0-9]+$ ]] && (( disk_mb < DEPLOY_MIN_DISK_MB )); then
    die "Espaço em disco insuficiente: ${disk_mb}MB livres; mínimo ${DEPLOY_MIN_DISK_MB}MB."
  fi
  log "Espaço livre em disco: ${disk_mb}MB"

  log "Diretório da aplicação: $APP_DIR"
  log "Modo: $DEPLOY_MODE | processo: $DEPLOY_PROCESS | branch: $DEPLOY_BRANCH"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN: nenhuma alteração será feita."
  fi
}

check_network() {
  local need_git=0 need_npm=0 need_ytdlp=0
  if [[ "$DEPLOY_MODE" != "ytdlp" ]]; then
    need_git=1
    if [[ "$DEPLOY_SKIP_NPM" -ne 1 ]]; then need_npm=1; fi
  fi
  if [[ "$DEPLOY_MODE" != "code" ]]; then need_ytdlp=1; fi

  if [[ "$DEPLOY_SKIP_NETWORK_CHECK" -eq 1 ]]; then
    log_warn "Verificação de rede desabilitada por DEPLOY_SKIP_NETWORK_CHECK=1."
    return 0
  fi

  log_step "Verificando conectividade"
  if [[ "$need_git" -eq 1 ]]; then
    if ! GIT_TERMINAL_PROMPT=0 git -C "$APP_DIR" ls-remote --exit-code --heads "$DEPLOY_REMOTE" "$DEPLOY_BRANCH" >/dev/null 2>&1; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        log_warn "Não foi possível consultar o remote Git (dry-run continuará)."
      else
        die "Não foi possível consultar $DEPLOY_REMOTE/$DEPLOY_BRANCH."
      fi
    else
      log "Remote Git acessível: $DEPLOY_REMOTE/$DEPLOY_BRANCH"
    fi
  fi

  if [[ "$need_npm" -eq 1 ]]; then
    if ! curl -fsSI --max-time 15 https://registry.npmjs.org/ >/dev/null 2>&1; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        log_warn "Registry npm inacessível (dry-run continuará)."
      else
        die "Registry npm inacessível."
      fi
    else
      log "Registry npm acessível."
    fi
  fi

  if [[ "$need_ytdlp" -eq 1 ]]; then
    if [[ "$YTDLP_METHOD" == "apt" ]]; then
      log "yt-dlp via apt: a conectividade será validada pelo próprio apt-get update."
    elif [[ "$YTDLP_METHOD" =~ ^(pip|venv|pipx|docker)$ ]]; then
      if ! curl -fsSI --max-time 15 https://pypi.org/simple/yt-dlp/ >/dev/null 2>&1; then
        if [[ "$DRY_RUN" -eq 1 ]]; then
          log_warn "PyPI inacessível (dry-run continuará)."
        else
          die "PyPI inacessível; não é possível atualizar o yt-dlp com segurança."
        fi
      else
        log "PyPI/yt-dlp acessível."
      fi
    else
      if ! curl -fsSI --max-time 15 https://github.com/yt-dlp/yt-dlp/releases/latest >/dev/null 2>&1; then
        if [[ "$DRY_RUN" -eq 1 ]]; then
          log_warn "GitHub/yt-dlp inacessível (dry-run continuará)."
        else
          die "GitHub/yt-dlp inacessível; não é possível atualizar o yt-dlp com segurança."
        fi
      else
        log "Releases do yt-dlp acessíveis."
      fi
    fi
  fi
}

check_git_state() {
  [[ -d "$APP_DIR/.git" ]] || die "Repositório Git não encontrado em $APP_DIR."

  local branch
  branch="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" != "$DEPLOY_BRANCH" ]]; then
    die "Branch atual '$branch' difere da branch de produção '$DEPLOY_BRANCH'. Faça checkout manual antes do deploy."
  fi

  if git -C "$APP_DIR" cat-file -e "$DEPLOY_REMOTE/$DEPLOY_BRANCH^{commit}" 2>/dev/null; then
    log "Branch de produção: $DEPLOY_BRANCH ($DEPLOY_REMOTE/$DEPLOY_BRANCH)"
  else
    log "Branch de produção: $DEPLOY_BRANCH (remote será consultado)"
  fi

  local tracked_changes
  tracked_changes="$(git -C "$APP_DIR" status --porcelain --untracked-files=no)"
  if [[ -n "$tracked_changes" ]]; then
    if [[ "$DEPLOY_ALLOW_DIRTY" -eq 1 ]]; then
      log_warn "Há alterações locais rastreadas e --allow-dirty foi usado. O merge continuará apenas se não houver conflito."
    else
      printf '%s\n' "$tracked_changes" >&2
      die "Há alterações locais rastreadas. Faça commit/stash antes do deploy (ou use --allow-dirty conscientemente)."
    fi
  fi

  local untracked
  untracked="$(git -C "$APP_DIR" ls-files --others --exclude-standard || true)"
  if [[ -n "$untracked" ]]; then
    log_warn "Existem arquivos não rastreados (serão preservados):"
    printf '%s\n' "$untracked" | sed 's/^/  - /' >&2
  fi

  if git -C "$APP_DIR" ls-files --error-unmatch .env >/dev/null 2>&1; then
    log_warn "O arquivo .env está rastreado no Git. Remova-o do índice para evitar vazamento de segredos."
  fi
}

# -----------------------------------------------------------------------------
# Detecção do mecanismo de execução
# -----------------------------------------------------------------------------
pid_matches_entry() {
  local pid="$1" entry="$2"
  local cwd cmd
  cwd="$(proc_cwd "$pid")"
  [[ "$cwd" == "$APP_DIR" ]] || return 1
  cmd="$(proc_cmdline "$pid")"
  string_has_entry "$cmd" "$entry" || return 1
  [[ "$cmd" == *node* ]] || return 1
  return 0
}

systemd_unit_value() {
  local unit="$1" key="$2"
  systemctl show -p "$key" --value "$unit" 2>/dev/null || true
}

systemd_unit_entry() {
  local unit="$1" exec entry
  exec="$(systemd_unit_value "$unit" ExecStart)"

  for entry in "${ENTRY_FILES[@]}"; do
    if string_has_entry "$exec" "$entry"; then
      printf '%s' "$entry"
      return 0
    fi
  done

  # Unidades com nome explícito de API ou servidor.
  if [[ "$unit" == *api* ]]; then
    for entry in "${ENTRY_FILES[@]}"; do
      if [[ "$entry" == "api_server.js" ]]; then
        printf '%s' "$entry"
        return 0
      fi
    done
    return 1
  fi
  if [[ "$unit" == *server* ]]; then
    for entry in "${ENTRY_FILES[@]}"; do
      if [[ "$entry" == "server.js" ]]; then
        printf '%s' "$entry"
        return 0
      fi
    done
  fi

  # Não mistura server e api quando o ExecStart aponta para o outro entry.
  if [[ "$exec" == *server.js* || "$exec" == *api_server.js* ]]; then
    return 1
  fi

  printf '%s' "${ENTRY_FILES[0]}"
}

systemd_unit_references_app() {
  local unit="$1" wd exec resolved_wd
  systemctl cat "$unit" >/dev/null 2>&1 || return 1

  wd="$(systemd_unit_value "$unit" WorkingDirectory)"
  exec="$(systemd_unit_value "$unit" ExecStart)"

  if [[ -n "$wd" ]]; then
    resolved_wd="$(realpath -m -- "$wd" 2>/dev/null || printf '%s' "$wd")"
    [[ "$resolved_wd" == "$APP_DIR" ]] && return 0
  fi
  [[ "$exec" == *"$APP_DIR"* ]] && return 0

  return 1
}

systemd_add_unit() {
  local unit="$1" entry="${2:-}" existing pid
  [[ -n "$unit" ]] || return 0

  for existing in "${SYSTEMD_UNITS[@]}"; do
    [[ "$existing" == "$unit" ]] && return 0
  done

  if [[ -z "$entry" ]]; then
    entry="$(systemd_unit_entry "$unit")" || return 0
  fi

  SYSTEMD_UNITS+=("$unit")
  SYSTEMD_ENTRIES+=("$entry")

  if [[ -z "$SERVICE_PID" ]]; then
    pid="$(systemd_unit_value "$unit" MainPID)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )); then
      SERVICE_PID="$pid"
    fi
  fi
}

detect_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 1
  local units unit pid cwd cmd entry app_name cgroup d

  SYSTEMD_UNITS=()
  SYSTEMD_ENTRIES=()
  SERVICE_PID=""

  # 1) Unidades em execução (MainPID ou WorkingDirectory/ExecStart no APP_DIR).
  units="$(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}' || true)"
  while IFS= read -r unit; do
    [[ -n "$unit" ]] || continue

    pid="$(systemd_unit_value "$unit" MainPID)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )); then
      cwd="$(proc_cwd "$pid")"
      cmd="$(proc_cmdline "$pid")"
      if [[ "$cwd" == "$APP_DIR" && "$cmd" == *node* ]]; then
        for entry in "${ENTRY_FILES[@]}"; do
          if string_has_entry "$cmd" "$entry"; then
            systemd_add_unit "$unit" "$entry"
            break
          fi
        done
        # MainPID é um wrapper (npm, sh, etc.); tenta inferir pelo unit.
        systemd_add_unit "$unit"
      fi
    fi

    if systemd_unit_references_app "$unit"; then
      systemd_add_unit "$unit"
    fi
  done <<< "$units"

  # 2) Processos Node do APP_DIR, mapeados pelo cgroup do systemd.
  # Cobre serviços cujo MainPID é um wrapper ou que não aparecem no list-units.
  shopt -s nullglob
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue

    cwd="$(proc_cwd "$pid")"
    [[ "$cwd" == "$APP_DIR" ]] || continue
    cmd="$(proc_cmdline "$pid")"
    [[ "$cmd" == *node* ]] || continue

    cgroup="$(cat "/proc/$pid/cgroup" 2>/dev/null || true)"
    [[ -n "$cgroup" ]] || continue
    unit="$(printf '%s\n' "$cgroup" | sed -n 's#.*/\([^/]*\.service\)$#\1#p' | head -1)"
    [[ -n "$unit" ]] || continue
    # Evita confundir gerenciadores (ex.: pm2-root.service) com o serviço da app.
    systemd_unit_references_app "$unit" || continue

    for entry in "${ENTRY_FILES[@]}"; do
      if string_has_entry "$cmd" "$entry"; then
        systemd_add_unit "$unit" "$entry"
        break
      fi
    done
  done
  shopt -u nullglob

  # 3) Unidades instaladas cujo nome deriva do diretório da aplicação.
  # Inclui serviços parados e nomes como isalvei-api.service. O alias
  # "isalvei" cobre instalações cujo APP_DIR tem outro nome.
  app_name="$(basename "$APP_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_.-')"
  if [[ -n "$app_name" ]]; then
    units="$(systemctl list-unit-files --type=service --no-legend --plain 2>/dev/null \
      | awk -v app="$app_name" 'index(tolower($1), app) || index(tolower($1), "isalvei") {print $1}' || true)"
    while IFS= read -r unit; do
      [[ -n "$unit" ]] || continue
      systemd_unit_references_app "$unit" || continue
      systemd_add_unit "$unit"
    done <<< "$units"
  fi

  [[ "${#SYSTEMD_UNITS[@]}" -gt 0 ]]
}

detect_pm2() {
  command -v pm2 >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || die "jq é necessário para detectar aplicações PM2."
  local json line name pid cwd exec_path entry found
  json="$(pm2 jlist 2>/dev/null || true)"
  [[ -n "$json" ]] || return 1

  while IFS=$'\t' read -r name pid cwd exec_path; do
    [[ -n "$name" ]] || continue
    [[ "$cwd" == "$APP_DIR" ]] || continue
    found=""
    for entry in "${ENTRY_FILES[@]}"; do
      if string_has_entry "$exec_path" "$entry" || [[ "$name" == *"${entry%.js}"* ]]; then
        found="$entry"
        break
      fi
    done
    [[ -n "$found" ]] || continue
    PM2_APPS+=("$name")
    PM2_ENTRIES+=("$found")
    if [[ -z "$SERVICE_PID" && "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )); then
      SERVICE_PID="$pid"
    fi
  done < <(printf '%s' "$json" | jq -r '.[] | [.name, (.pid // 0), (.pm2_env.pm_cwd // ""), (.pm2_env.pm_exec_path // "")] | @tsv' 2>/dev/null || true)

  [[ "${#PM2_APPS[@]}" -gt 0 ]]
}

detect_direct() {
  local d pid cwd cmd entry found
  DIRECT_PIDS=()
  DIRECT_ENTRIES=()
  SERVICE_PID=""
  shopt -s nullglob
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    if [[ "$pid" == "$$" || "$pid" == "$PPID" ]]; then
      continue
    fi
    cwd="$(proc_cwd "$pid")"
    [[ "$cwd" == "$APP_DIR" ]] || continue
    cmd="$(proc_cmdline "$pid")"
    [[ "$cmd" == *node* ]] || continue
    for entry in "${ENTRY_FILES[@]}"; do
      if string_has_entry "$cmd" "$entry"; then
        DIRECT_PIDS+=("$pid")
        DIRECT_ENTRIES+=("$entry")
        SERVICE_PID="${SERVICE_PID:-$pid}"
        break
      fi
    done
  done
  shopt -u nullglob
  [[ "${#DIRECT_PIDS[@]}" -gt 0 ]]
}

docker_container_from_inspect() {
  local cid="$1" mounts source
  mounts="$("${DOCKER[@]}" inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' "$cid" 2>/dev/null || true)"
  while IFS= read -r source; do
    [[ -n "$source" ]] || continue
    if [[ "$source" == "$APP_DIR" || "$source" == "$APP_DIR"/* ]]; then
      return 0
    fi
  done <<< "$mounts"
  return 1
}

detect_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  DOCKER=(docker)
  if ! docker info >/dev/null 2>&1; then
    if [[ "${#SUDO[@]}" -gt 0 ]] && "${SUDO[@]}" docker info >/dev/null 2>&1; then
      DOCKER=("${SUDO[@]}" docker)
    else
      return 1
    fi
  fi

  local cid name image matches=()
  if [[ -n "$DEPLOY_DOCKER_CONTAINER" ]]; then
    DOCKER_CONTAINER="$DEPLOY_DOCKER_CONTAINER"
    if "${DOCKER[@]}" inspect "$DEPLOY_DOCKER_CONTAINER" >/dev/null 2>&1; then
      DOCKER_CONTAINER_EXISTS=1
    else
      # Primeiro deploy com nome explícito.
      DOCKER_CONTAINER_EXISTS=0
    fi
    return 0
  fi

  while IFS=$'\t' read -r cid name image; do
    [[ -n "$cid" ]] || continue
    if [[ "$name" == *isalvei* || "$image" == *isalvei* ]] || docker_container_from_inspect "$cid"; then
      matches+=("$cid|$name")
    fi
  done < <("${DOCKER[@]}" ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}' 2>/dev/null || true)

  if [[ "${#matches[@]}" -eq 0 ]]; then
    return 1
  fi
  if [[ "${#matches[@]}" -gt 1 ]]; then
    log_error "Mais de um container candidato encontrado:"
    printf '  %s\n' "${matches[@]}" >&2
    die "Defina DEPLOY_DOCKER_CONTAINER explicitamente."
  fi
  DOCKER_CONTAINER="${matches[0]#*|}"
  DOCKER_CONTAINER_EXISTS=1
  return 0
}

detect_method() {
  log_step "Detectando mecanismo de execução"
  local detected=""

  if [[ "$DEPLOY_METHOD" != "auto" ]]; then
    detected="$DEPLOY_METHOD"
    log "Método informado explicitamente: $detected"
  else
    if detect_docker; then
      detected="docker"
    elif detect_systemd; then
      detected="systemd"
    elif detect_pm2; then
      detected="pm2"
    elif detect_direct; then
      detected="node"
    else
      die "Não foi possível detectar systemd, PM2, Docker ou processo Node em $APP_DIR. Informe --method e a configuração correspondente (veja docs/DEPLOY.md)."
    fi
    log "Método detectado: $detected"
  fi

  case "$detected" in
    docker)
      setup_docker_cmd
      detect_docker || die "Container Docker do iSalvei não encontrado. Defina DEPLOY_DOCKER_CONTAINER."
      ;;
    systemd)
      if [[ -n "$DEPLOY_SYSTEMD_SERVICES" ]]; then
        read -r -a SYSTEMD_UNITS <<< "$DEPLOY_SYSTEMD_SERVICES"
        SYSTEMD_ENTRIES=()
        local svc entry found
        for svc in "${SYSTEMD_UNITS[@]}"; do
          found=""
          for entry in "${ENTRY_FILES[@]}"; do
            if [[ "$svc" == *"${entry%.js}"* || "$svc" == *api* && "$entry" == "api_server.js" ]]; then
              found="$entry"; break
            fi
          done
          SYSTEMD_ENTRIES+=("${found:-server.js}")
        done
        refresh_service_pid
      else
        detect_systemd || die "Serviço systemd do iSalvei não encontrado. Defina DEPLOY_SYSTEMD_SERVICES."
      fi
      ;;
    pm2)
      if [[ -n "$DEPLOY_PM2_APPS" ]]; then
        read -r -a PM2_APPS <<< "$DEPLOY_PM2_APPS"
        PM2_ENTRIES=()
        local app entry found
        for app in "${PM2_APPS[@]}"; do
          found=""
          for entry in "${ENTRY_FILES[@]}"; do
            if [[ "$app" == *"${entry%.js}"* || "$app" == *api* && "$entry" == "api_server.js" ]]; then
              found="$entry"; break
            fi
          done
          PM2_ENTRIES+=("${found:-server.js}")
        done
        refresh_service_pid
      else
        detect_pm2 || die "Aplicação PM2 do iSalvei não encontrada. Defina DEPLOY_PM2_APPS."
      fi
      ;;
    node)
      if ! detect_direct; then
        log_warn "Nenhum processo Node do iSalvei encontrado; o deploy iniciará o processo (modo node)."
      fi
      ;;
  esac

  METHOD="$detected"

  if [[ "$METHOD" == "systemd" ]]; then
    log "Unidade(s) systemd: ${SYSTEMD_UNITS[*]}"
  fi

  if [[ "$METHOD" == "docker" ]]; then
    command -v jq >/dev/null 2>&1 || die "jq é necessário no modo Docker."
    setup_docker_cmd
    if [[ "$DEPLOY_PROCESS" != "server" ]]; then
      die "O Dockerfile do repositório executa server.js. Para api/both no Docker, use DEPLOY_DOCKER_CMD ou ajuste o Dockerfile."
    fi
  fi

  if [[ "$METHOD" == "systemd" && "${#SYSTEMD_UNITS[@]}" -eq 0 ]]; then
    die "Nenhuma unidade systemd configurada."
  fi
  if [[ "$METHOD" == "pm2" && "${#PM2_APPS[@]}" -eq 0 ]]; then
    die "Nenhuma aplicação PM2 configurada."
  fi
}

preflight_method() {
  log_step "Validando permissões do mecanismo ($METHOD)"
  case "$METHOD" in
    systemd)
      command -v systemctl >/dev/null 2>&1 || die "systemctl não encontrado."
      if [[ "${EUID:-$(id -u)}" -ne 0 && "${#SUDO[@]}" -eq 0 ]]; then
        die "Restart via systemd requer root ou sudo sem senha (sudo -n)."
      fi
      local unit wd
      for unit in "${SYSTEMD_UNITS[@]}"; do
        wd="$(systemctl show -p WorkingDirectory --value "$unit" 2>/dev/null || true)"
        if [[ -n "$wd" && "$wd" != "$APP_DIR" ]]; then
          die "Unidade $unit usa WorkingDirectory=$wd, diferente de $APP_DIR."
        fi
        systemctl cat "$unit" >/dev/null 2>&1 || die "Unidade systemd não encontrada: $unit"
      done
      ;;
    pm2)
      command -v pm2 >/dev/null 2>&1 || die "pm2 não encontrado."
      local app
      for app in "${PM2_APPS[@]}"; do
        pm2 describe "$app" >/dev/null 2>&1 || die "Aplicação PM2 não encontrada: $app"
      done
      ;;
    docker)
      setup_docker_cmd
      require_cmd git
      require_cmd jq
      [[ -f "$APP_DIR/Dockerfile" ]] || die "Dockerfile não encontrado em $APP_DIR."
      if [[ ! -d "$APP_DIR/.git" ]]; then
        die "O modo Docker exige um repositório Git para validar o que será construído."
      fi
      ;;
    node)
      # O usuário precisa poder encerrar o processo antigo (mesmo dono).
      local pid
      for pid in "${DIRECT_PIDS[@]:-}"; do
        [[ -n "$pid" ]] || continue
        kill -0 "$pid" 2>/dev/null || die "Sem permissão para sinalizar o processo $pid."
      done
      ;;
  esac
}

# -----------------------------------------------------------------------------
# Contexto de runtime (PATH, yt-dlp, ffmpeg)
# -----------------------------------------------------------------------------
refresh_service_pid() {
  SERVICE_PID=""
  case "$METHOD" in
    systemd)
      local unit pid
      for unit in "${SYSTEMD_UNITS[@]}"; do
        pid="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)"
        if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )); then
          SERVICE_PID="$pid"
          break
        fi
      done
      ;;
    pm2)
      command -v jq >/dev/null 2>&1 || return 0
      local json pid
      json="$(pm2 jlist 2>/dev/null || true)"
      [[ -n "$json" ]] || return 0
      pid="$(printf '%s' "$json" | jq -r --arg app "${PM2_APPS[0]:-}" '.[] | select(.name==$app) | .pid // 0' 2>/dev/null | head -1)"
      if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )); then
        SERVICE_PID="$pid"
      fi
      ;;
    node)
      if [[ "${#DIRECT_PIDS[@]}" -gt 0 ]]; then
        SERVICE_PID="${DIRECT_PIDS[0]}"
      fi
      ;;
  esac
}

setup_runtime_context() {
  log_step "Resolvendo ambiente de execução do backend"

  if [[ "$METHOD" == "docker" ]]; then
    if [[ "$DOCKER_CONTAINER_EXISTS" -eq 1 ]]; then
      DOCKER_OLD_IMAGE_ID="$("${DOCKER[@]}" inspect -f '{{.Image}}' "$DOCKER_CONTAINER" 2>/dev/null || true)"
      DOCKER_OLD_IMAGE_REF="$("${DOCKER[@]}" inspect -f '{{.Config.Image}}' "$DOCKER_CONTAINER" 2>/dev/null || true)"
      YTDLP_OLD_VERSION="$("${DOCKER[@]}" exec "$DOCKER_CONTAINER" yt-dlp --version 2>/dev/null | tr -d '\r' | head -1 || true)"
      FFMPEG_VERSION="$("${DOCKER[@]}" exec "$DOCKER_CONTAINER" ffmpeg -version 2>/dev/null | head -1 || true)"
      FFPROBE_VERSION="$("${DOCKER[@]}" exec "$DOCKER_CONTAINER" ffprobe -version 2>/dev/null | head -1 || true)"
      if [[ -z "$YTDLP_OLD_VERSION" ]]; then
        YTDLP_OLD_VERSION="$("${DOCKER[@]}" run --rm --entrypoint yt-dlp "$DOCKER_OLD_IMAGE_ID" --version 2>/dev/null | tr -d '\r' | head -1 || true)"
      fi
    fi
    if [[ -z "$YTDLP_OLD_VERSION" ]]; then
      log_warn "Não foi possível ler a versão atual do yt-dlp no container (primeiro deploy?)."
    else
      log "yt-dlp atual no container: $YTDLP_OLD_VERSION"
    fi
    if [[ -n "$FFMPEG_VERSION" ]]; then
      log "FFmpeg atual no container: $FFMPEG_VERSION"
    fi
    if [[ -n "$FFPROBE_VERSION" ]]; then
      log "ffprobe atual no container: $FFPROBE_VERSION"
    fi
    YTDLP_METHOD="docker"
    return 0
  fi

  refresh_service_pid

  if [[ -n "$SERVICE_PID" ]]; then
    RUNTIME_PATH="$(proc_env "$SERVICE_PID" PATH || true)"
    [[ -n "$RUNTIME_PATH" ]] || RUNTIME_PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"
    log "Processo do backend: PID $SERVICE_PID"
    log "PATH do processo do backend: $RUNTIME_PATH"
  elif [[ "$METHOD" == "systemd" && "${#SYSTEMD_UNITS[@]}" -gt 0 ]]; then
    RUNTIME_PATH="$(systemd_env_value "${SYSTEMD_UNITS[0]}" PATH || true)"
    RUNTIME_PATH="${RUNTIME_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
    log_warn "Serviço systemd parado; usando PATH configurado/default do systemd: $RUNTIME_PATH"
  elif [[ "$METHOD" == "pm2" ]]; then
    RUNTIME_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    log_warn "Nenhum PID PM2 ativo; usando PATH padrão do sistema: $RUNTIME_PATH"
  else
    log_warn "Nenhum processo em execução; usando PATH do shell e .env para resolver dependências."
  fi

  YTDLP_CONFIGURED=""
  if [[ -z "$SERVICE_PID" && "$METHOD" == "systemd" && "${#SYSTEMD_UNITS[@]}" -gt 0 ]]; then
    YTDLP_CONFIGURED="$(systemd_env_value "${SYSTEMD_UNITS[0]}" YTDLP_PATH || true)"
  fi
  if [[ -z "$YTDLP_CONFIGURED" ]]; then
    YTDLP_CONFIGURED="$(runtime_env_get YTDLP_PATH || true)"
  fi
  YTDLP_CONFIGURED="${YTDLP_CONFIGURED:-yt-dlp}"

  FFMPEG_CONFIGURED=""
  if [[ -z "$SERVICE_PID" && "$METHOD" == "systemd" && "${#SYSTEMD_UNITS[@]}" -gt 0 ]]; then
    FFMPEG_CONFIGURED="$(systemd_env_value "${SYSTEMD_UNITS[0]}" FFMPEG_PATH || true)"
  fi
  if [[ -z "$FFMPEG_CONFIGURED" ]]; then
    FFMPEG_CONFIGURED="$(runtime_env_get FFMPEG_PATH || true)"
  fi
  FFMPEG_CONFIGURED="${FFMPEG_CONFIGURED:-ffmpeg}"

  FFPROBE_CONFIGURED=""
  if [[ -z "$SERVICE_PID" && "$METHOD" == "systemd" && "${#SYSTEMD_UNITS[@]}" -gt 0 ]]; then
    FFPROBE_CONFIGURED="$(systemd_env_value "${SYSTEMD_UNITS[0]}" FFPROBE_PATH || true)"
  fi
  if [[ -z "$FFPROBE_CONFIGURED" ]]; then
    FFPROBE_CONFIGURED="$(runtime_env_get FFPROBE_PATH || true)"
  fi
  FFPROBE_CONFIGURED="${FFPROBE_CONFIGURED:-ffprobe}"

  YTDLP_BIN="$(resolve_bin "$YTDLP_CONFIGURED" "$RUNTIME_PATH" || true)"
  if [[ -z "$YTDLP_BIN" || ! -x "$YTDLP_BIN" ]]; then
    die "yt-dlp não encontrado/executável (YTDLP_PATH='$YTDLP_CONFIGURED', PATH='$RUNTIME_PATH')."
  fi

  FFMPEG_BIN="$(resolve_bin "$FFMPEG_CONFIGURED" "$RUNTIME_PATH" || true)"
  if [[ -z "$FFMPEG_BIN" || ! -x "$FFMPEG_BIN" ]]; then
    die "FFmpeg não encontrado/executável (FFMPEG_PATH='$FFMPEG_CONFIGURED', PATH='$RUNTIME_PATH')."
  fi

  FFPROBE_BIN="$(resolve_bin "$FFPROBE_CONFIGURED" "$RUNTIME_PATH" || true)"
  if [[ -z "$FFPROBE_BIN" || ! -x "$FFPROBE_BIN" ]]; then
    die "ffprobe não encontrado/executável (FFPROBE_PATH='$FFPROBE_CONFIGURED', PATH='$RUNTIME_PATH')."
  fi

  YTDLP_OLD_VERSION="$("$YTDLP_BIN" --version 2>/dev/null | tr -d '\r' | head -1 || true)"
  [[ -n "$YTDLP_OLD_VERSION" ]] || die "yt-dlp em $YTDLP_BIN não respondeu a --version."
  FFMPEG_VERSION="$("$FFMPEG_BIN" -version 2>/dev/null | head -1 || true)"
  [[ -n "$FFMPEG_VERSION" ]] || die "FFmpeg em $FFMPEG_BIN não respondeu a -version."
  FFPROBE_VERSION="$("$FFPROBE_BIN" -version 2>/dev/null | head -1 || true)"
  [[ -n "$FFPROBE_VERSION" ]] || die "ffprobe em $FFPROBE_BIN não respondeu a -version."

  detect_ytdlp_install "$YTDLP_BIN"
  YTDLP_METHOD="$YTDLP_METHOD_RESULT"
  log "yt-dlp configurado: $YTDLP_CONFIGURED"
  log "yt-dlp resolvido: $YTDLP_BIN"
  log "yt-dlp versão atual: $YTDLP_OLD_VERSION"
  log "Método de instalação do yt-dlp: $YTDLP_METHOD"
  log "FFmpeg: $FFMPEG_BIN ($FFMPEG_VERSION)"
  log "ffprobe: $FFPROBE_BIN ($FFPROBE_VERSION)"

  if [[ "$DEPLOY_MODE" != "code" ]]; then
    case "$YTDLP_METHOD" in
      apt)
        if [[ "${EUID:-$(id -u)}" -ne 0 && "${#SUDO[@]}" -eq 0 ]]; then
          die "Atualização do yt-dlp via apt requer root ou sudo sem senha."
        fi
        if [[ -n "$REQUESTED_YTDLP_VERSION" ]]; then
          die "O método apt não permite fixar uma versão arbitrária. Use venv/pipx/standalone ou remova --yt-dlp-version."
        fi
        ;;
      standalone)
        [[ -w "$YTDLP_BIN" && -w "$(dirname "$YTDLP_BIN")" ]] || die "Sem permissão de escrita para atualizar o binário standalone em $YTDLP_BIN."
        ;;
      pip|venv)
        [[ -n "$YTDLP_PYTHON" && -x "$YTDLP_PYTHON" ]] || die "Interpretador Python do yt-dlp não identificado."
        if "$YTDLP_PYTHON" -c 'import sys; raise SystemExit(0 if sys.prefix==sys.base_prefix else 1)' 2>/dev/null; then
          if [[ "${EUID:-$(id -u)}" -eq 0 || -n "${SUDO_USER:-}" ]]; then
            log_warn "Pacote yt-dlp instalado no Python do sistema. Se o pip bloquear por PEP 668, use venv/pipx/standalone."
          fi
        fi
        ;;
      pipx)
        # pipx é atualizado via pipx ou, no fallback, via pip do venv.
        ;;
      unknown)
        die "Método de instalação do yt-dlp não reconhecido. Defina DEPLOY_YTDLP_METHOD (pipx|venv|pip|apt|standalone)."
        ;;
    esac
  fi
}

is_venv_python() {
  local py="$1"
  local dir
  dir="$(dirname "$py")"
  if [[ -f "$dir/../pyvenv.cfg" ]]; then
    return 0
  fi
  "$py" -c 'import sys; raise SystemExit(0 if sys.prefix != sys.base_prefix else 1)' >/dev/null 2>&1
}

parse_shebang_python() {
  local file="$1" first interp arg py
  first="$(head -1 "$file" 2>/dev/null || true)"
  [[ "$first" == '#!'* ]] || return 1
  read -r interp arg _ <<< "${first#\#!}"
  if [[ "$(basename "$interp")" == "env" ]]; then
    py="$(PATH="$RUNTIME_PATH" command -v "${arg:-python3}" 2>/dev/null || true)"
  else
    py="$interp"
    [[ "$py" = /* ]] || py="$(PATH="$RUNTIME_PATH" command -v "$py" 2>/dev/null || true)"
  fi
  [[ -n "$py" && -x "$py" ]] || return 1
  printf '%s\n' "$py"
}

detect_ytdlp_install() {
  local bin="$1" real size first real_py
  real="$(realpath -m -- "$bin" 2>/dev/null || printf '%s' "$bin")"
  YTDLP_METHOD_RESULT="unknown"

  if [[ "$DEPLOY_YTDLP_METHOD" != "auto" ]]; then
    YTDLP_METHOD_RESULT="$DEPLOY_YTDLP_METHOD"
    # Preenche o Python quando aplicável.
    if [[ "$DEPLOY_YTDLP_METHOD" =~ ^(pip|venv|pipx)$ ]]; then
      YTDLP_PYTHON="$(parse_shebang_python "$real" || true)"
    fi
    return 0
  fi

  # Pacote do sistema (apt/dpkg)
  if command -v dpkg >/dev/null 2>&1 && dpkg -S "$real" >/dev/null 2>&1; then
    if dpkg -S "$real" 2>/dev/null | grep -q '^yt-dlp:'; then
      YTDLP_METHOD_RESULT="apt"
      return 0
    fi
  fi

  # Binário standalone/zipapp (grande ou ELF)
  size="$(stat -c%s "$real" 2>/dev/null || echo 0)"
  first="$(head -c4 "$real" 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"
  if [[ "$first" == "7f454c46" ]] || (( size > 1048576 )); then
    YTDLP_METHOD_RESULT="standalone"
    return 0
  fi

  real_py="$(parse_shebang_python "$real" || true)"
  if [[ -n "$real_py" ]]; then
    if "$real_py" -m pip show yt-dlp >/dev/null 2>&1; then
      YTDLP_PYTHON="$real_py"
      if [[ "$real" == */pipx/venvs/* ]]; then
        YTDLP_METHOD_RESULT="pipx"
      elif is_venv_python "$real_py"; then
        YTDLP_METHOD_RESULT="venv"
      else
        YTDLP_METHOD_RESULT="pip"
      fi
      return 0
    fi
  fi

  # Fallback: launcher pequeno pode ser pipx sem pip show acessível.
  if [[ "$real" == */pipx/venvs/* ]]; then
    YTDLP_PYTHON="$real_py"
    YTDLP_METHOD_RESULT="pipx"
    return 0
  fi

  return 0
}

# -----------------------------------------------------------------------------
# Versão alvo do yt-dlp
# -----------------------------------------------------------------------------
resolve_latest_ytdlp_version() {
  local effective
  effective="$(curl -fsSL --max-time 25 -o /dev/null -w '%{url_effective}' https://github.com/yt-dlp/yt-dlp/releases/latest 2>/dev/null || true)"
  local tag="${effective##*/}"
  if ! validate_version_format "$tag"; then
    die "Não foi possível resolver a versão mais recente do yt-dlp (resposta: '$tag'). Use --yt-dlp-version."
  fi
  printf '%s\n' "$tag"
}

# Maior versão estável do PyPI cujo Requires-Python aceita o interpretador
# usado pelo yt-dlp. Evita tentar a "latest" quando ela exige Python mais novo.
resolve_latest_compatible_ytdlp_version() {
  local python="$1" py_version json
  [[ -n "$python" && -x "$python" ]] || return 1

  py_version="$("$python" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || true)"
  [[ -n "$py_version" ]] || return 1

  json="$(curl -fsSL --max-time 25 https://pypi.org/pypi/yt-dlp/json 2>/dev/null || true)"
  [[ -n "$json" ]] || return 1

  printf '%s' "$json" | node -e '
    const target = process.argv[1].split(".").map(Number);
    let data = "";
    process.stdin.on("data", d => data += d);
    process.stdin.on("end", () => {
      const releases = JSON.parse(data).releases || {};
      const tuple = v => v.split(".").map(Number);

      function cmp(a, b) {
        const n = Math.max(a.length, b.length);
        for (let i = 0; i < n; i++) {
          const x = a[i] || 0, y = b[i] || 0;
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      }

      function satisfies(spec) {
        if (!spec) return true;
        for (const raw of spec.split(",")) {
          const part = raw.trim();
          const m = part.match(/^(>=|<=|==|!=|>|<|~=)\s*(\d+(?:\.\d+)*)(\.\*)?$/);
          if (!m) return false;
          const op = m[1], v = tuple(m[2]), wildcard = Boolean(m[3]);

          if ((op === "==" || op === "!=") && wildcard) {
            const same = cmp(target.slice(0, v.length), v) === 0;
            if (op === "==" && !same) return false;
            if (op === "!=" && same) return false;
            continue;
          }

          const c = cmp(target, v);
          if (op === ">=" && c < 0) return false;
          if (op === ">" && c <= 0) return false;
          if (op === "<=" && c > 0) return false;
          if (op === "<" && c >= 0) return false;
          if (op === "==" && c !== 0) return false;
          if (op === "!=" && c === 0) return false;
          if (op === "~=") {
            const upper = v.length <= 2 ? [v[0] + 1, 0] : [v[0], v[1] + 1];
            if (c < 0 || cmp(target, upper) >= 0) return false;
          }
        }
        return true;
      }

      let best = "";
      for (const [version, files] of Object.entries(releases)) {
        if (!/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(version)) continue;
        if (!Array.isArray(files) || files.length === 0) continue;
        if (files.every(f => f && f.yanked)) continue;
        const spec = (files.find(f => f && f.requires_python) || {}).requires_python || "";
        if (!satisfies(spec)) continue;
        if (!best || cmp(tuple(version), tuple(best)) > 0) best = version;
      }

      if (!best) process.exit(1);
      process.stdout.write(best);
    });
  ' "$py_version"
}

resolve_targets() {
  log_step "Definindo versões alvo"

  if [[ "$DEPLOY_MODE" == "code" ]]; then
    if [[ -z "$YTDLP_OLD_VERSION" ]]; then
      die "Modo --code-only no Docker exige uma versão atual do yt-dlp no container para fixar no build."
    fi
    YTDLP_TARGET_VERSION="$YTDLP_OLD_VERSION"
    YTDLP_NEW_VERSION="$YTDLP_OLD_VERSION"
    log "Código somente: yt-dlp será mantido em $YTDLP_TARGET_VERSION."
  elif [[ "$YTDLP_METHOD" == "apt" && -z "$REQUESTED_YTDLP_VERSION" ]]; then
    YTDLP_TARGET_VERSION="apt"
    log "yt-dlp via apt: será usada a versão candidata do repositório do sistema (sem versão fixa)."
  elif [[ -n "$REQUESTED_YTDLP_VERSION" ]]; then
    YTDLP_TARGET_VERSION="$REQUESTED_YTDLP_VERSION"
    log "Versão do yt-dlp fixada por configuração: $YTDLP_TARGET_VERSION"
  else
    local latest compatible py_version
    latest="$(resolve_latest_ytdlp_version)"
    YTDLP_TARGET_VERSION="$latest"
    log "Versão mais recente do yt-dlp: $latest"

    if [[ "$YTDLP_METHOD" =~ ^(pip|venv|pipx)$ && -n "$YTDLP_PYTHON" ]]; then
      compatible="$(resolve_latest_compatible_ytdlp_version "$YTDLP_PYTHON" || true)"
      if [[ -n "$compatible" && "$(normalize_version "$compatible")" != "$(normalize_version "$latest")" ]]; then
        py_version="$("$YTDLP_PYTHON" -V 2>&1 || true)"
        log_warn "yt-dlp $latest não é compatível com $py_version; usando a versão mais recente compatível: $compatible."
        YTDLP_TARGET_VERSION="$compatible"
      fi
    fi
  fi

  if [[ -n "$YTDLP_OLD_VERSION" && "$YTDLP_TARGET_VERSION" != "apt" ]]; then
    if [[ "$(normalize_version "$YTDLP_OLD_VERSION")" == "$(normalize_version "$YTDLP_TARGET_VERSION")" ]]; then
      log "yt-dlp já está na versão alvo."
    else
      log "yt-dlp será atualizado: $YTDLP_OLD_VERSION -> $YTDLP_TARGET_VERSION"
    fi
  fi

  if [[ "$DEPLOY_MODE" != "code" ]]; then
    RESTART_REQUIRED=1
  fi
}

# -----------------------------------------------------------------------------
# Backup e estado
# -----------------------------------------------------------------------------
create_backup() {
  local ts="$1"
  BACKUP_DIR="$BACKUP_ROOT/$ts"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  log_step "Criando ponto de recuperação em $BACKUP_DIR"

  {
    printf 'timestamp=%s\n' "$START_ISO"
    printf 'commit_before=%s\n' "$COMMIT_BEFORE"
    printf 'branch=%s\n' "$DEPLOY_BRANCH"
    printf 'method=%s\n' "$METHOD"
    printf 'ytdlp_old_version=%s\n' "$YTDLP_OLD_VERSION"
    printf 'ytdlp_method=%s\n' "$YTDLP_METHOD"
  } > "$BACKUP_DIR/metadata.env"
  chmod 600 "$BACKUP_DIR/metadata.env"

  if [[ -d "$APP_DIR/.git" && "$DEPLOY_MODE" != "ytdlp" ]]; then
    if ! git -C "$APP_DIR" bundle create "$BACKUP_DIR/repo.bundle" HEAD >/dev/null 2>&1; then
      log_warn "Não foi possível criar git bundle; o commit $COMMIT_BEFORE continua registrado."
    fi
  fi

  if [[ -f "$APP_DIR/.env" ]]; then
    cp -p "$APP_DIR/.env" "$BACKUP_DIR/env.backup"
    chmod 600 "$BACKUP_DIR/env.backup"
  fi

  # Dados persistentes locais
  local db_path db_abs
  db_path="$(env_get API_DB_PATH || true)"
  db_path="${db_path:-./data/api.db}"
  if [[ "$db_path" = /* ]]; then
    db_abs="$db_path"
  else
    db_abs="$APP_DIR/${db_path#./}"
  fi
  if [[ -f "$db_abs" ]]; then
    mkdir -p "$BACKUP_DIR/data"
    if command -v sqlite3 >/dev/null 2>&1; then
      if sqlite3 "$db_abs" ".backup '$BACKUP_DIR/data/api.db'" >/dev/null 2>&1; then
        log "Banco SQLite copiado de forma consistente."
      else
        cp -p "$db_abs" "$BACKUP_DIR/data/api.db" || log_warn "Falha ao copiar o banco SQLite."
      fi
    elif [[ -f "$APP_DIR/node_modules/better-sqlite3/package.json" ]]; then
      if node "$SCRIPT_DIR/db-backup.js" "$db_abs" "$BACKUP_DIR/data/api.db" >/dev/null 2>&1; then
        log "Banco SQLite copiado via better-sqlite3."
      else
        cp -p "$db_abs" "$BACKUP_DIR/data/api.db" || log_warn "Falha ao copiar o banco SQLite."
      fi
    else
      cp -p "$db_abs" "$BACKUP_DIR/data/api.db" || log_warn "Falha ao copiar o banco SQLite."
    fi
  fi

  if [[ -d "$APP_DIR/data" ]]; then
    if tar -czf "$BACKUP_DIR/data.tgz" -C "$APP_DIR" data 2>/dev/null; then
      log "Diretório data/ arquivado."
    else
      log_warn "Não foi possível arquivar data/."
    fi
  fi

  local cookies
  cookies="$(env_get COOKIES_FILE || true)"
  if [[ -n "$cookies" ]]; then
    local cookies_abs="$cookies"
    [[ "$cookies_abs" = /* ]] || cookies_abs="$APP_DIR/${cookies#./}"
    if [[ -f "$cookies_abs" && "$cookies_abs" == "$APP_DIR"/* ]]; then
      mkdir -p "$BACKUP_DIR/config"
      cp -p "$cookies_abs" "$BACKUP_DIR/config/cookies.txt"
      chmod 600 "$BACKUP_DIR/config/cookies.txt"
    else
      log_warn "COOKIES_FILE está fora do diretório da aplicação ou não existe; não foi copiado."
    fi
  fi

  if [[ "$METHOD" == "docker" && "$DOCKER_CONTAINER_EXISTS" -eq 1 ]]; then
    if "${DOCKER[@]}" cp "$DOCKER_CONTAINER:/app/data" "$BACKUP_DIR/docker-data" >/dev/null 2>&1; then
      log "Dados /app/data do container copiados."
    else
      log_warn "Não foi possível copiar /app/data do container (pode não existir)."
    fi
    "${DOCKER[@]}" inspect "$DOCKER_CONTAINER" > "$BACKUP_DIR/container-inspect.json" 2>/dev/null || true
  fi

  ln -sfn "$BACKUP_DIR" "$BACKUP_ROOT/latest"
  prune_backups "$ts"
  DEPLOY_STARTED=1
}

prune_backups() {
  local current="$1" keep="$DEPLOY_BACKUP_KEEP"
  [[ "$keep" =~ ^[0-9]+$ ]] || return 0
  (( keep > 0 )) || return 0
  local dirs=()
  while IFS= read -r d; do
    [[ -n "$d" ]] || continue
    if [[ "$d" == "$current" ]]; then
      continue
    fi
    dirs+=("$d")
  done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -r | tail -n +$((keep + 1)))
  local d
  for d in "${dirs[@]:-}"; do
    [[ -n "$d" ]] || continue
    rm -rf -- "$BACKUP_ROOT/$d"
    log "Backup antigo removido: $d"
  done
}

# -----------------------------------------------------------------------------
# Atualização de código e dependências
# -----------------------------------------------------------------------------
update_code() {
  log_step "Buscando atualizações do Git"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    local remote_line remote_sha
    remote_line="$(GIT_TERMINAL_PROMPT=0 git -C "$APP_DIR" ls-remote --heads "$DEPLOY_REMOTE" "$DEPLOY_BRANCH" 2>/dev/null || true)"
    remote_sha="$(printf '%s\n' "$remote_line" | awk '{print $1}' | head -1)"
    if [[ -z "$remote_sha" ]]; then
      log_warn "[dry-run] Não foi possível consultar o remote; o deploy real faria git fetch."
      return 0
    fi
    if [[ "$remote_sha" == "$COMMIT_BEFORE" ]]; then
      log "[dry-run] Código já está no commit remoto $remote_sha."
    else
      log "[dry-run] Seria executado: git fetch $DEPLOY_REMOTE $DEPLOY_BRANCH && git merge --ff-only $DEPLOY_REMOTE/$DEPLOY_BRANCH"
      log "[dry-run] Commit local: $COMMIT_BEFORE | remoto: $remote_sha"
      CODE_CHANGED_PLANNED=1
    fi
    return 0
  fi

  GIT_TERMINAL_PROMPT=0 git -C "$APP_DIR" fetch --prune "$DEPLOY_REMOTE" "$DEPLOY_BRANCH"
  local remote_ref="$DEPLOY_REMOTE/$DEPLOY_BRANCH"
  local remote_sha local_sha
  remote_sha="$(git -C "$APP_DIR" rev-parse "$remote_ref")"
  local_sha="$(git -C "$APP_DIR" rev-parse HEAD)"

  if [[ "$local_sha" == "$remote_sha" ]]; then
    log "Código já está atualizado ($local_sha)."
    COMMIT_AFTER="$local_sha"
    return 0
  fi

  if git -C "$APP_DIR" merge-base --is-ancestor "$local_sha" "$remote_sha"; then
    # Não sobrescrever arquivos não rastreados que o merge criaria.
    local incoming untracked conflicts
    incoming="$(git -C "$APP_DIR" diff --name-only "$local_sha..$remote_sha" || true)"
    untracked="$(git -C "$APP_DIR" ls-files --others --exclude-standard || true)"
    conflicts="$(comm -12 <(printf '%s\n' "$incoming" | sort -u) <(printf '%s\n' "$untracked" | sort -u) || true)"
    if [[ -n "$conflicts" ]]; then
      printf '%s\n' "$conflicts" >&2
      die "Arquivos não rastreados conflitam com a atualização. Mova/remova-os manualmente."
    fi

    log "Atualizando código: $local_sha -> $remote_sha"
    git -C "$APP_DIR" merge --ff-only "$remote_ref"
    COMMIT_AFTER="$(git -C "$APP_DIR" rev-parse HEAD)"
    CODE_CHANGED=1
    log "Código atualizado para $COMMIT_AFTER."
  elif git -C "$APP_DIR" merge-base --is-ancestor "$remote_sha" "$local_sha"; then
    die "A branch local está à frente de $remote_ref. Publique ou faça checkout da versão de produção antes do deploy."
  else
    die "Branch local e remota divergiram. Resolva manualmente (sem git reset --hard) antes do deploy."
  fi
}

install_deps() {
  if [[ "$DEPLOY_MODE" == "ytdlp" ]]; then
    return 0
  fi
  if [[ "$DEPLOY_SKIP_NPM" -eq 1 ]]; then
    log_warn "npm ci ignorado por --skip-npm."
    return 0
  fi
  if [[ "$METHOD" == "docker" ]]; then
    return 0
  fi

  log_step "Instalando dependências Node.js"
  local -a flags=(--omit=dev --no-audit --no-fund)
  local -a extra_flags=()
  if [[ -n "$DEPLOY_NPM_FLAGS" ]]; then
    read -r -a extra_flags <<< "$DEPLOY_NPM_FLAGS"
    flags+=("${extra_flags[@]}")
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ -f "$APP_DIR/package-lock.json" ]]; then
      log "[dry-run] Seria executado: npm ci ${flags[*]}"
    else
      log "[dry-run] Seria executado: npm install ${flags[*]}"
    fi
    return 0
  fi

  DEPS_CHANGED=1
  if [[ -f "$APP_DIR/package-lock.json" ]]; then
    ( cd "$APP_DIR" && npm ci "${flags[@]}" )
  else
    log_warn "package-lock.json ausente; usando npm install."
    ( cd "$APP_DIR" && npm install "${flags[@]}" )
  fi
}

run_code_checks() {
  if [[ "$DEPLOY_MODE" == "ytdlp" ]]; then
    return 0
  fi
  log_step "Executando verificações de sintaxe e testes"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] Seria executado: node --check server.js api_server.js api_migrate.js"
    if [[ "$DEPLOY_RUN_TESTS" -eq 1 ]]; then
      log "[dry-run] Seria executado: npm test (se configurado)"
    fi
    return 0
  fi

  local node_bin="node"
  local files=(server.js api_server.js api_migrate.js)
  local f
  for f in "${files[@]}"; do
    [[ -f "$APP_DIR/$f" ]] || continue
    "$node_bin" --check "$APP_DIR/$f"
  done

  # Scripts do frontend (exceto vendor)
  while IFS= read -r -d '' f; do
    "$node_bin" --check "$f"
  done < <(find "$APP_DIR/frontend" -type f -name '*.js' -not -path '*/vendor/*' -print0 2>/dev/null || true)

  # Scripts do próprio deploy
  for f in "$SCRIPT_DIR"/*.js; do
    if [[ -f "$f" ]]; then
      "$node_bin" --check "$f"
    fi
  done
  if [[ -f "$SCRIPT_DIR/deploy.sh" ]]; then
    bash -n "$SCRIPT_DIR/deploy.sh"
  fi

  if [[ "$DEPLOY_RUN_TESTS" -eq 1 ]]; then
    if node -e 'const p=require(process.argv[1]); process.exit(p.scripts && p.scripts.test ? 0 : 1)' "$APP_DIR/package.json" >/dev/null 2>&1; then
      ( cd "$APP_DIR" && npm test --silent )
    else
      log_warn "Nenhum script npm test configurado; pulando testes automatizados."
    fi
  else
    log_warn "Testes automatizados ignorados por --skip-tests."
  fi
}

# -----------------------------------------------------------------------------
# Atualização do yt-dlp (não-Docker)
# -----------------------------------------------------------------------------
get_ytdlp_version() {
  "$YTDLP_BIN" --version 2>/dev/null | tr -d '\r' | head -1
}

backup_ytdlp() {
  local dir="$BACKUP_DIR/ytdlp"
  mkdir -p "$dir"
  chmod 700 "$dir"
  {
    printf 'method=%s\n' "$YTDLP_METHOD"
    printf 'bin=%s\n' "$YTDLP_BIN"
    printf 'version=%s\n' "$YTDLP_OLD_VERSION"
    printf 'python=%s\n' "$YTDLP_PYTHON"
    printf 'apt_version=%s\n' "$YTDLP_APT_OLD_VERSION"
  } > "$dir/metadata.env"
  chmod 600 "$dir/metadata.env"

  case "$YTDLP_METHOD" in
    standalone)
      cp -p "$YTDLP_BIN" "$dir/yt-dlp.bin" && chmod 700 "$dir/yt-dlp.bin" || log_warn "Falha ao copiar binário standalone do yt-dlp."
      ;;
    pip|venv|pipx)
      if [[ -n "$YTDLP_PYTHON" && -x "$YTDLP_PYTHON" ]]; then
        mkdir -p "$dir/wheels"
        if ! "$YTDLP_PYTHON" -m pip download --dest "$dir/wheels" "yt-dlp[default,curl-cffi]==$YTDLP_OLD_VERSION" >/dev/null 2>&1; then
          log_warn "Não foi possível baixar o wheel da versão atual do yt-dlp para rollback offline."
        fi
      fi
      ;;
    apt)
      if command -v dpkg-query >/dev/null 2>&1; then
        YTDLP_APT_OLD_VERSION="$(dpkg-query -W -f='${Version}' yt-dlp 2>/dev/null || true)"
        printf 'apt_version=%s\n' "$YTDLP_APT_OLD_VERSION" >> "$dir/metadata.env"
      fi
      mkdir -p "$dir/deb"
      if ! ( cd "$dir/deb" && apt-get download "yt-dlp=${YTDLP_APT_OLD_VERSION}" >/dev/null 2>&1 ); then
        log_warn "Não foi possível baixar o .deb atual do yt-dlp para rollback."
      fi
      ;;
  esac
}

update_ytdlp_non_docker() {
  log_step "Atualizando yt-dlp no ambiente do backend"
  local target="$YTDLP_TARGET_VERSION"
  local current_norm="" target_norm=""

  if [[ "$target" != "apt" ]]; then
    current_norm="$(normalize_version "$YTDLP_OLD_VERSION")"
    target_norm="$(normalize_version "$target")"
    if [[ "$current_norm" == "$target_norm" ]]; then
      log "yt-dlp já está em $YTDLP_OLD_VERSION; nada a atualizar."
      YTDLP_NEW_VERSION="$YTDLP_OLD_VERSION"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        run_runtime_check "$YTDLP_NEW_VERSION"
      fi
      return 0
    fi
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    case "$YTDLP_METHOD" in
      pip|venv) log "[dry-run] Seria executado: $YTDLP_PYTHON -m pip install --upgrade yt-dlp[default,curl-cffi]==$target" ;;
      pipx) log "[dry-run] Seria executado: pipx install --force yt-dlp[default,curl-cffi]==$target" ;;
      apt) log "[dry-run] Seria executado: sudo apt-get update && sudo apt-get install --only-upgrade -y yt-dlp" ;;
      standalone) log "[dry-run] Seria baixado e verificado o binário yt-dlp $target, com instalação atômica em $YTDLP_BIN" ;;
    esac
    if [[ "$target" == "apt" ]]; then
      YTDLP_NEW_VERSION="$YTDLP_OLD_VERSION"
    else
      YTDLP_NEW_VERSION="$target"
    fi
    return 0
  fi

  backup_ytdlp
  YTDLP_UPDATE_ATTEMPTED=1

  case "$YTDLP_METHOD" in
    pip|venv)
      [[ -n "$YTDLP_PYTHON" ]] || die "Python do yt-dlp não identificado."
      PIP_DISABLE_PIP_VERSION_CHECK=1 "$YTDLP_PYTHON" -m pip install --upgrade "yt-dlp[default,curl-cffi]==$target"
      ;;
    pipx)
      if command -v pipx >/dev/null 2>&1; then
        pipx install --force "yt-dlp[default,curl-cffi]==$target"
      else
        [[ -n "$YTDLP_PYTHON" ]] || die "pipx ausente e Python do venv não identificado."
        PIP_DISABLE_PIP_VERSION_CHECK=1 "$YTDLP_PYTHON" -m pip install --upgrade "yt-dlp[default,curl-cffi]==$target"
      fi
      ;;
    apt)
      run_privileged apt-get update -qq
      run_privileged apt-get install --only-upgrade -y --no-install-recommends yt-dlp
      ;;
    standalone)
      install_standalone_ytdlp "$target"
      ;;
    *)
      die "Método de instalação não suportado: $YTDLP_METHOD"
      ;;
  esac

  YTDLP_NEW_VERSION="$(get_ytdlp_version || true)"
  [[ -n "$YTDLP_NEW_VERSION" ]] || die "yt-dlp não respondeu após a atualização (possível instalação quebrada)."
  log "yt-dlp atualizado: $YTDLP_OLD_VERSION -> $YTDLP_NEW_VERSION"

  if [[ "$YTDLP_METHOD" != "apt" ]]; then
    if [[ "$(normalize_version "$YTDLP_NEW_VERSION")" != "$(normalize_version "$target")" ]]; then
      die "Versão instalada ($YTDLP_NEW_VERSION) difere da versão alvo ($target)."
    fi
  else
    YTDLP_TARGET_VERSION="$YTDLP_NEW_VERSION"
    log_warn "apt não garante a versão exata; versão instalada: $YTDLP_NEW_VERSION."
  fi

  YTDLP_UPDATED=1
  run_runtime_check "$YTDLP_NEW_VERSION"
}

install_standalone_ytdlp() {
  local version="$1" base sums tmp bin_hash expected
  base="https://github.com/yt-dlp/yt-dlp/releases/download/$version"
  tmp="$WORK_TMP/yt-dlp-$version"
  sums="$WORK_TMP/SHA2-256SUMS"

  log "Baixando yt-dlp $version..."
  curl -fL --retry 3 --connect-timeout 15 --max-time 180 -o "$tmp" "$base/yt-dlp"
  curl -fL --retry 3 --connect-timeout 15 --max-time 60 -o "$sums" "$base/SHA2-256SUMS"

  expected="$(awk '$2=="yt-dlp" {print $1; exit}' "$sums")"
  [[ -n "$expected" ]] || die "Checksum do yt-dlp não encontrado em SHA2-256SUMS."
  bin_hash="$(sha256sum "$tmp" | awk '{print $1}')"
  [[ "$bin_hash" == "$expected" ]] || die "Checksum inválido para yt-dlp $version."
  chmod 700 "$tmp"

  local target="$YTDLP_BIN"
  local new_file="${target}.new.$$"
  install -m 0755 "$tmp" "$new_file"
  mv -f "$new_file" "$target"
  log "Binário yt-dlp instalado atomicamente em $target."
}

restore_ytdlp() {
  log_warn "Tentando restaurar yt-dlp $YTDLP_OLD_VERSION..."
  local dir="$BACKUP_DIR/ytdlp"
  local restored=1

  case "$YTDLP_METHOD" in
    standalone)
      if [[ -f "$dir/yt-dlp.bin" ]]; then
        install -m 0755 "$dir/yt-dlp.bin" "${YTDLP_BIN}.rollback.$$" && mv -f "${YTDLP_BIN}.rollback.$$" "$YTDLP_BIN" && restored=0
      fi
      ;;
    pip|venv)
      if [[ -d "$dir/wheels" ]]; then
        PIP_DISABLE_PIP_VERSION_CHECK=1 "$YTDLP_PYTHON" -m pip install --force-reinstall --no-index --find-links "$dir/wheels" "yt-dlp[default,curl-cffi]==$YTDLP_OLD_VERSION" >/dev/null 2>&1 && restored=0
      fi
      if [[ "$restored" -ne 0 && -n "$YTDLP_PYTHON" ]]; then
        PIP_DISABLE_PIP_VERSION_CHECK=1 "$YTDLP_PYTHON" -m pip install --force-reinstall "yt-dlp[default,curl-cffi]==$YTDLP_OLD_VERSION" >/dev/null 2>&1 && restored=0
      fi
      ;;
    pipx)
      if command -v pipx >/dev/null 2>&1; then
        pipx install --force "yt-dlp[default,curl-cffi]==$YTDLP_OLD_VERSION" >/dev/null 2>&1 && restored=0
      fi
      if [[ "$restored" -ne 0 && -n "$YTDLP_PYTHON" ]]; then
        PIP_DISABLE_PIP_VERSION_CHECK=1 "$YTDLP_PYTHON" -m pip install --force-reinstall "yt-dlp[default,curl-cffi]==$YTDLP_OLD_VERSION" >/dev/null 2>&1 && restored=0
      fi
      ;;
    apt)
      local deb
      deb="$(find "$dir/deb" -maxdepth 1 -name '*.deb' -print -quit 2>/dev/null || true)"
      if [[ -n "$deb" ]]; then
        run_privileged dpkg -i "$deb" >/dev/null 2>&1 && restored=0
      fi
      if [[ "$restored" -ne 0 && -n "$YTDLP_APT_OLD_VERSION" ]]; then
        run_privileged apt-get install --allow-downgrades -y "yt-dlp=$YTDLP_APT_OLD_VERSION" >/dev/null 2>&1 && restored=0
      fi
      ;;
  esac

  local now
  now="$(get_ytdlp_version || true)"
  if [[ "$restored" -eq 0 && "$(normalize_version "$now")" == "$(normalize_version "$YTDLP_OLD_VERSION")" ]]; then
    log "yt-dlp restaurado para $now."
    return 0
  fi
  log_error "Não foi possível restaurar yt-dlp para $YTDLP_OLD_VERSION (versão atual: '${now:-desconhecida}')."
  return 1
}

run_runtime_check() {
  local expected="${1:-}"
  log_step "Validando yt-dlp e FFmpeg no ambiente de execução"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] Seria executado: node scripts/runtime-check.js --expect-ytdlp ${expected:-<atual>}"
    return 0
  fi

  local out
  if [[ "$METHOD" == "docker" ]]; then
    local -a args=(exec)
    local user
    user="$("${DOCKER[@]}" inspect -f '{{.Config.User}}' "$DOCKER_CONTAINER" 2>/dev/null || true)"
    if [[ -n "$user" ]]; then args+=(-u "$user"); fi
    args+=("$DOCKER_CONTAINER" node scripts/runtime-check.js)
    if [[ -n "$expected" ]]; then args+=(--expect-ytdlp "$expected"); fi
    if ! out="$("${DOCKER[@]}" "${args[@]}" 2>&1)"; then
      printf '%s\n' "$out" >&2
      log_error "Runtime check falhou dentro do container."
      return 1
    fi
  else
    local -a env_args=("PATH=$RUNTIME_PATH")
    if [[ -n "$YTDLP_CONFIGURED" ]]; then env_args+=("YTDLP_PATH=$YTDLP_CONFIGURED"); fi
    if [[ -n "$FFMPEG_CONFIGURED" ]]; then env_args+=("FFMPEG_PATH=$FFMPEG_CONFIGURED"); fi
    if [[ -n "$FFPROBE_CONFIGURED" ]]; then env_args+=("FFPROBE_PATH=$FFPROBE_CONFIGURED"); fi
    local -a cmd=(node "$SCRIPT_DIR/runtime-check.js")
    if [[ -n "$expected" ]]; then cmd+=(--expect-ytdlp "$expected"); fi
    if ! out="$( cd "$APP_DIR" && env "${env_args[@]}" APP_DIR="$APP_DIR" "${cmd[@]}" 2>&1 )"; then
      printf '%s\n' "$out" >&2
      log_error "Runtime check falhou: yt-dlp/FFmpeg indisponíveis ou versão divergente."
      return 1
    fi
  fi

  log "Runtime check: $out"
  local resolved expected_resolved
  resolved="$(printf '%s' "$out" | json_field ytdlp.resolved || true)"
  if [[ "$METHOD" != "docker" && -n "$resolved" ]]; then
    expected_resolved="$(realpath -m -- "$YTDLP_BIN" 2>/dev/null || printf '%s' "$YTDLP_BIN")"
    if [[ "$(realpath -m -- "$resolved" 2>/dev/null || printf '%s' "$resolved")" != "$expected_resolved" ]]; then
      log_error "O backend resolveria yt-dlp em '$resolved', mas o deploy atualizou '$expected_resolved'."
      return 1
    fi
    log "Executável confirmado pelo backend: $resolved"
  fi
}

# -----------------------------------------------------------------------------
# Restart / deploy Docker
# -----------------------------------------------------------------------------
capture_direct_log_offsets() {
  DIRECT_LOG_OFFSETS=()
  local entry f size
  for entry in "${ENTRY_FILES[@]}"; do
    f="$LOG_DIR/app-$entry.log"
    if [[ -f "$f" ]]; then
      size="$(stat -c%s "$f" 2>/dev/null || echo 0)"
    else
      size=0
    fi
    DIRECT_LOG_OFFSETS+=("$size")
  done
}

stop_direct_entry() {
  local entry="$1" pid="" pidfile="$DEPLOY_STATE_DIR/app-$1.pid" i
  if [[ -f "$pidfile" ]]; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
  fi
  if [[ -n "$pid" && -d "/proc/$pid" ]] && ! pid_matches_entry "$pid" "$entry"; then
    log_warn "PID $pid do arquivo $pidfile não corresponde a $entry; ignorando PID antigo."
    pid=""
  fi
  if [[ -z "$pid" || ! -d "/proc/$pid" ]]; then
    pid=""
    local d p cwd cmd
    shopt -s nullglob
    for d in /proc/[0-9]*; do
      p="${d#/proc/}"
      if [[ "$p" == "$$" ]]; then
        continue
      fi
      cwd="$(proc_cwd "$p")"
      [[ "$cwd" == "$APP_DIR" ]] || continue
      cmd="$(proc_cmdline "$p")"
      if [[ "$cmd" == *node* ]] && string_has_entry "$cmd" "$entry"; then
        pid="$p"; break
      fi
    done
    shopt -u nullglob
  fi
  [[ -n "$pid" ]] || return 0

  log "Encerrando processo $entry (PID $pid)..."
  kill -TERM "$pid" 2>/dev/null || true
  for ((i = 0; i < 20; i++)); do
    [[ -d "/proc/$pid" ]] || break
    sleep 1
  done
  if [[ -d "/proc/$pid" ]]; then
    log_warn "Processo $pid não encerrou com SIGTERM; enviando SIGKILL."
    kill -KILL "$pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$pidfile"
}

start_direct_entry() {
  local entry="$1" pidfile="$DEPLOY_STATE_DIR/app-$1.pid" logfile="$LOG_DIR/app-$1.log"
  mkdir -p "$LOG_DIR"
  touch "$logfile"
  log "Iniciando $entry em background (log: $logfile)..."
  (
    cd "$APP_DIR"
    nohup node "$entry" >> "$logfile" 2>&1 &
    echo $! > "$pidfile"
  )
  sleep 1
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ -z "$pid" || ! -d "/proc/$pid" ]]; then
    log_error "Falha ao iniciar $entry."
    return 1
  fi
  log "$entry iniciado (PID $pid)."
}

restart_app() {
  if [[ "$NO_RESTART" -eq 1 ]]; then
    die "Restart necessário, mas --no-restart foi informado."
  fi
  log_step "Reiniciando a aplicação ($METHOD)"
  RESTART_STARTED=1

  if [[ "$DRY_RUN" -eq 1 ]]; then
    case "$METHOD" in
      systemd) log "[dry-run] Seria executado: systemctl restart ${SYSTEMD_UNITS[*]}" ;;
      pm2) log "[dry-run] Seria executado: pm2 restart ${PM2_APPS[*]} --update-env && pm2 save" ;;
      node) log "[dry-run] Seriam reiniciados: ${ENTRY_FILES[*]}" ;;
    esac
    return 0
  fi

  case "$METHOD" in
    systemd)
      run_privileged systemctl restart "${SYSTEMD_UNITS[@]}"
      ;;
    pm2)
      local app
      for app in "${PM2_APPS[@]}"; do
        pm2 restart "$app" --update-env
      done
      pm2 save
      ;;
    node)
      capture_direct_log_offsets
      local entry
      for entry in "${ENTRY_FILES[@]}"; do
        stop_direct_entry "$entry"
      done
      refresh_service_pid
      for entry in "${ENTRY_FILES[@]}"; do
        start_direct_entry "$entry"
      done
      detect_direct >/dev/null 2>&1 || true
      refresh_service_pid
      ;;
  esac
}

wait_process_active() {
  local deadline=$((SECONDS + DEPLOY_PROCESS_WAIT))
  local active=1
  while (( SECONDS < deadline )); do
    active=0
    case "$METHOD" in
      systemd)
        local unit
        for unit in "${SYSTEMD_UNITS[@]}"; do
          systemctl is-active --quiet "$unit" || active=1
        done
        ;;
      pm2)
        command -v jq >/dev/null 2>&1 || return 0
        local json app state
        json="$(pm2 jlist 2>/dev/null || true)"
        for app in "${PM2_APPS[@]}"; do
          state="$(printf '%s' "$json" | jq -r --arg app "$app" '.[] | select(.name==$app) | .pm2_env.status' 2>/dev/null | head -1)"
          [[ "$state" == "online" ]] || active=1
        done
        ;;
      node)
        local pidfile pid
        for entry in "${ENTRY_FILES[@]}"; do
          pidfile="$DEPLOY_STATE_DIR/app-$entry.pid"
          pid="$(cat "$pidfile" 2>/dev/null || true)"
          [[ -n "$pid" && -d "/proc/$pid" ]] || active=1
        done
        ;;
    esac
    if [[ "$active" -eq 0 ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

docker_detect_health_url() {
  [[ "$METHOD" == "docker" ]] || return 1
  local app_port binding host_ip host_port host_url_ip
  app_port="$("${DOCKER[@]}" exec "$DOCKER_CONTAINER" printenv PORT 2>/dev/null | tr -d '\r' | head -1 || true)"
  app_port="${app_port:-3000}"
  DOCKER_CONTAINER_PORT="$app_port"
  binding="$("${DOCKER[@]}" port "$DOCKER_CONTAINER" "$app_port/tcp" 2>/dev/null | head -1 || true)"
  if [[ -n "$binding" ]]; then
    host_port="${binding##*:}"
    host_ip="${binding%:*}"
    host_ip="${host_ip#[}"
    host_ip="${host_ip%]}"
    host_url_ip="$host_ip"
    if [[ -z "$host_url_ip" || "$host_url_ip" == "0.0.0.0" || "$host_url_ip" == "::" ]]; then
      host_url_ip="127.0.0.1"
    fi
    if [[ "$host_url_ip" == *:* ]]; then
      host_url_ip="[$host_url_ip]"
    fi
    DOCKER_HOST_PORT="$host_port"
    HEALTH_URLS=("http://$host_url_ip:$host_port/health")
    return 0
  fi
  return 1
}

docker_exec_health() {
  local timeout="${1:-$DEPLOY_HEALTH_TIMEOUT}"
  local deadline=$((SECONDS + timeout))
  local app_port="${DOCKER_CONTAINER_PORT:-3000}"
  while (( SECONDS < deadline )); do
    if "${DOCKER[@]}" exec "$DOCKER_CONTAINER" node -e '
      const port = process.argv[1];
      fetch("http://127.0.0.1:" + port + "/health")
        .then(r => r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status)))
        .then(t => process.exit(/\"ok\"\s*:\s*true/.test(t) ? 0 : 1))
        .catch(() => process.exit(1));
    ' "$app_port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

build_health_urls() {
  HEALTH_URLS=()
  if [[ -n "$DEPLOY_HEALTH_URL" ]]; then
    HEALTH_URLS=("$DEPLOY_HEALTH_URL")
    return 0
  fi

  if [[ "$METHOD" == "docker" ]]; then
    docker_detect_health_url || true
    return 0
  fi

  local port_value api_port_value entry
  port_value="$(runtime_env_get PORT || true)"
  port_value="${port_value:-3000}"
  api_port_value="$(runtime_env_get API_PORT || true)"
  api_port_value="${api_port_value:-$port_value}"

  for entry in "${ENTRY_FILES[@]}"; do
    if [[ "$entry" == "api_server.js" ]]; then
      HEALTH_URLS+=("http://127.0.0.1:$api_port_value/health")
    else
      HEALTH_URLS+=("http://127.0.0.1:$port_value/health")
    fi
  done
}

http_health() {
  local url="$1" timeout="${2:-$DEPLOY_HEALTH_TIMEOUT}"
  local deadline=$((SECONDS + timeout))
  local body code
  body="$(mktemp "${TMPDIR:-/tmp}/isalvei-health.XXXXXX")"
  while (( SECONDS < deadline )); do
    code="$(curl -sS -o "$body" -w '%{http_code}' --max-time 4 "$url" 2>/dev/null || true)"
    if [[ "$code" == "200" ]] && grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$body" 2>/dev/null; then
      rm -f "$body"
      return 0
    fi
    sleep 2
  done
  rm -f "$body"
  return 1
}

startup_logs() {
  case "$METHOD" in
    systemd)
      local unit out=""
      for unit in "${SYSTEMD_UNITS[@]}"; do
        if journalctl -u "$unit" --since "@$START_EPOCH" --no-pager -n 200 >/dev/null 2>&1; then
          out+="$(journalctl -u "$unit" --since "@$START_EPOCH" --no-pager -n 200 2>/dev/null || true)"$'\n'
        elif [[ "${#SUDO[@]}" -gt 0 ]]; then
          out+="$("${SUDO[@]}" journalctl -u "$unit" --since "@$START_EPOCH" --no-pager -n 200 2>/dev/null || true)"$'\n'
        else
          log_warn "Sem permissão para ler journalctl da unidade $unit."
        fi
      done
      printf '%s' "$out"
      ;;
    pm2)
      local app out=""
      for app in "${PM2_APPS[@]}"; do
        out+="$(pm2 logs "$app" --lines 100 --nostream 2>&1 || true)"$'\n'
      done
      printf '%s' "$out"
      ;;
    node)
      local i entry f offset
      for i in "${!ENTRY_FILES[@]}"; do
        entry="${ENTRY_FILES[i]}"
        f="$LOG_DIR/app-$entry.log"
        offset="${DIRECT_LOG_OFFSETS[i]:-0}"
        [[ -f "$f" ]] || continue
        printf '%s\n' "--- $f ---"
        tail -c +$((offset + 1)) "$f" 2>/dev/null | tail -n 200 || true
      done
      ;;
    docker)
      "${DOCKER[@]}" logs --since "$START_EPOCH" "$DOCKER_CONTAINER" 2>&1 | tail -n 200 || true
      ;;
  esac
}

check_startup_logs() {
  local logs
  logs="$(startup_logs || true)"
  if [[ -z "$logs" ]]; then
    log_warn "Não foi possível ler logs de inicialização; seguindo com health check HTTP."
    return 0
  fi
  local pattern='EADDRINUSE|Cannot find module|MODULE_NOT_FOUND|UnhandledPromiseRejection|FATAL ERROR|Segmentation fault|exec format error|yt-dlp: not found|ffmpeg: not found'
  if printf '%s\n' "$logs" | grep -Eiq "$pattern"; then
    log_error "Erros críticos detectados nos logs de inicialização:"
    printf '%s\n' "$logs" | grep -Ei "$pattern" | tail -n 20 >&2
    return 1
  fi
  log "Nenhum erro crítico encontrado nos logs de inicialização."
}

health_and_validate() {
  log_step "Executando health checks"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] URLs de health: ${HEALTH_URLS[*]:-<detectadas após restart>}"
    return 0
  fi

  if ! wait_process_active; then
    startup_logs >&2 || true
    die "O processo não ficou ativo em ${DEPLOY_PROCESS_WAIT}s."
  fi

  build_health_urls
  local url
  if [[ "${#HEALTH_URLS[@]}" -eq 0 && "$METHOD" == "docker" ]]; then
    log "Aguardando health check dentro do container..."
    if ! docker_exec_health "$DEPLOY_HEALTH_TIMEOUT"; then
      startup_logs >&2 || true
      die "Health check dentro do container falhou."
    fi
    log "Health check OK (docker exec)."
  else
    for url in "${HEALTH_URLS[@]}"; do
      log "Aguardando health check: $url"
      if ! http_health "$url" "$DEPLOY_HEALTH_TIMEOUT"; then
        startup_logs >&2 || true
        die "Health check HTTP falhou: $url"
      fi
      log "Health check OK: $url"
    done
  fi

  if [[ "$METHOD" != "docker" ]]; then
    refresh_service_pid
    if [[ -n "$SERVICE_PID" ]]; then
      local new_path
      new_path="$(proc_env "$SERVICE_PID" PATH || true)"
      if [[ -n "$new_path" ]]; then
        RUNTIME_PATH="$new_path"
      fi
    fi
  fi

  local expected="$YTDLP_TARGET_VERSION"
  if [[ "$DEPLOY_MODE" == "code" ]]; then
    expected="$YTDLP_OLD_VERSION"
  fi
  if [[ "$METHOD" == "docker" ]]; then
    expected="$YTDLP_TARGET_VERSION"
  fi
  run_runtime_check "$expected"

  if ! check_startup_logs; then
    die "Logs de inicialização contêm erros críticos."
  fi
}

# -----------------------------------------------------------------------------
# Docker
# -----------------------------------------------------------------------------
docker_prepare_env_file() {
  DOCKER_ENV_FILE="$WORK_TMP/container.env"
  : > "$DOCKER_ENV_FILE"
  chmod 600 "$DOCKER_ENV_FILE"
  if [[ "$DOCKER_CONTAINER_EXISTS" -eq 1 ]]; then
    "${DOCKER[@]}" inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DOCKER_CONTAINER" \
      | grep -Ev '^(HOSTNAME|HOME)=' >> "$DOCKER_ENV_FILE" || true
  fi
}

docker_build_and_deploy() {
  log_step "Executando deploy Docker"
  local ts="$1"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] Seria executado: docker build -t $DEPLOY_DOCKER_IMAGE:$ts --build-arg YTDLP_VERSION=$YTDLP_TARGET_VERSION $APP_DIR"
    log "[dry-run] O container atual seria parado/renomeado e recriado com os mesmos mounts, portas e env."
    log "[dry-run] Health check: /health dentro do novo container."
    return 0
  fi

  if [[ "$NO_RESTART" -eq 1 ]]; then
    die "Modo Docker exige recriar o container; remova --no-restart."
  fi

  DOCKER_NEW_IMAGE="$DEPLOY_DOCKER_IMAGE:$ts"
  local -a build_args=()
  if [[ "$DEPLOY_DOCKER_PULL" -eq 1 ]]; then
    build_args+=(--pull)
  fi
  build_args+=(--build-arg "YTDLP_VERSION=$YTDLP_TARGET_VERSION")

  log "Construindo imagem $DOCKER_NEW_IMAGE (yt-dlp $YTDLP_TARGET_VERSION)..."
  if ! "${DOCKER[@]}" build "${build_args[@]}" -t "$DOCKER_NEW_IMAGE" "$APP_DIR"; then
    die "Build da imagem Docker falhou."
  fi
  DOCKER_NEW_IMAGE_ID="$("${DOCKER[@]}" image inspect -f '{{.Id}}' "$DOCKER_NEW_IMAGE")"
  log "Imagem construída: $DOCKER_NEW_IMAGE ($DOCKER_NEW_IMAGE_ID)"

  # Verificações dentro da imagem, antes de trocar o container.
  log_step "Validando imagem Docker"
  "${DOCKER[@]}" run --rm --entrypoint node "$DOCKER_NEW_IMAGE" --check server.js
  "${DOCKER[@]}" run --rm --entrypoint node "$DOCKER_NEW_IMAGE" --check api_server.js
  "${DOCKER[@]}" run --rm --entrypoint node "$DOCKER_NEW_IMAGE" --check api_migrate.js
  "${DOCKER[@]}" run --rm --entrypoint bash "$DOCKER_NEW_IMAGE" -n scripts/deploy.sh
  if [[ "$DEPLOY_RUN_TESTS" -eq 1 ]]; then
    # Testes do próprio deploy dentro da imagem. Os testes de download são
    # executados no host (quando node_modules está disponível) para evitar
    # depender de detalhes do runner em Node 22 dentro do container.
    if "${DOCKER[@]}" run --rm --entrypoint node "$DOCKER_NEW_IMAGE" -e 'const p=require("/app/package.json"); process.exit(p.scripts && p.scripts["test:deploy"] ? 0 : 1)' >/dev/null 2>&1; then
      "${DOCKER[@]}" run --rm --entrypoint npm "$DOCKER_NEW_IMAGE" run test:deploy --silent
    fi
  fi

  local new_ytdlp
  new_ytdlp="$("${DOCKER[@]}" run --rm --entrypoint yt-dlp "$DOCKER_NEW_IMAGE" --version 2>/dev/null | tr -d '\r' | head -1 || true)"
  [[ -n "$new_ytdlp" ]] || die "yt-dlp não respondeu na nova imagem."
  if [[ "$(normalize_version "$new_ytdlp")" != "$(normalize_version "$YTDLP_TARGET_VERSION")" ]]; then
    die "Imagem contém yt-dlp $new_ytdlp, diferente da versão alvo $YTDLP_TARGET_VERSION."
  fi
  YTDLP_NEW_VERSION="$new_ytdlp"
  log "yt-dlp na nova imagem: $YTDLP_NEW_VERSION"
  FFMPEG_VERSION="$("${DOCKER[@]}" run --rm --entrypoint ffmpeg "$DOCKER_NEW_IMAGE" -version 2>/dev/null | head -1 || true)"
  FFPROBE_VERSION="$("${DOCKER[@]}" run --rm --entrypoint ffprobe "$DOCKER_NEW_IMAGE" -version 2>/dev/null | head -1 || true)"

  # Preserva imagem antiga e prepara recriação do container.
  docker_prepare_env_file
  local -a run_args=(-d --name "$DOCKER_CONTAINER")
  local -a env_files=()
  if [[ -s "$DOCKER_ENV_FILE" ]]; then
    env_files+=(--env-file "$DOCKER_ENV_FILE")
  fi
  if [[ -f "$APP_DIR/.env" ]]; then
    env_files+=(--env-file "$APP_DIR/.env")
  fi

  local -a mounts=() ports=() extra=()
  local user network restart wd
  if [[ "$DOCKER_CONTAINER_EXISTS" -eq 1 ]]; then
    if [[ -n "$DOCKER_OLD_IMAGE_ID" ]]; then
      DOCKER_OLD_IMAGE_BACKUP="$DEPLOY_DOCKER_IMAGE:previous-$ts"
      "${DOCKER[@]}" tag "$DOCKER_OLD_IMAGE_ID" "$DOCKER_OLD_IMAGE_BACKUP"
      log "Imagem anterior preservada como $DOCKER_OLD_IMAGE_BACKUP"
    fi

    user="$("${DOCKER[@]}" inspect -f '{{.Config.User}}' "$DOCKER_CONTAINER")"
    network="$("${DOCKER[@]}" inspect -f '{{.HostConfig.NetworkMode}}' "$DOCKER_CONTAINER")"
    restart="$("${DOCKER[@]}" inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$DOCKER_CONTAINER")"
    wd="$("${DOCKER[@]}" inspect -f '{{.Config.WorkingDir}}' "$DOCKER_CONTAINER")"
    if [[ -n "$user" ]]; then run_args+=(-u "$user"); fi
    if [[ -n "$network" && "$network" != "default" && "$network" != "bridge" ]]; then
      run_args+=(--network "$network")
    fi
    if [[ -n "$restart" && "$restart" != "no" ]]; then
      run_args+=(--restart "$restart")
    fi
    if [[ -n "$wd" ]]; then run_args+=(-w "$wd"); fi

    while IFS=$'\t' read -r src dst rw; do
      [[ -n "$src" && -n "$dst" ]] || continue
      if [[ "$rw" == "false" ]]; then
        mounts+=(-v "$src:$dst:ro")
      else
        mounts+=(-v "$src:$dst")
      fi
    done < <("${DOCKER[@]}" inspect -f '{{range .Mounts}}{{println .Source "\t" .Destination "\t" .RW}}{{end}}' "$DOCKER_CONTAINER")

    while IFS=$'\t' read -r hip hport cport; do
      [[ -n "$hport" && -n "$cport" ]] || continue
      local proto="tcp"
      if [[ "$cport" == */* ]]; then
        proto="${cport##*/}"
        cport="${cport%%/*}"
      fi
      if [[ -n "$hip" && "$hip" != "0.0.0.0" && "$hip" != "::" ]]; then
        ports+=(-p "$hip:$hport:$cport/$proto")
      else
        ports+=(-p "$hport:$cport/$proto")
      fi
    done < <("${DOCKER[@]}" inspect -f '{{range $cp, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{println .HostIp "\t" .HostPort "\t" $cp}}{{end}}{{end}}' "$DOCKER_CONTAINER")
  else
    run_args+=(--restart unless-stopped)
    local host_port="${DEPLOY_DOCKER_PORTS:-}"
    if [[ -n "$host_port" ]]; then
      ports+=(-p "$host_port")
    else
      local app_port
      app_port="$(runtime_env_get PORT || true)"
      app_port="${app_port:-3000}"
      ports+=(-p "0.0.0.0:$app_port:$app_port")
    fi
    mkdir -p "$APP_DIR/data"
    mounts+=(-v "$APP_DIR/data:/app/data")
  fi

  if [[ -n "$DEPLOY_DOCKER_VOLUMES" ]]; then
    read -r -a extra_volumes <<< "$DEPLOY_DOCKER_VOLUMES"
    local v
    for v in "${extra_volumes[@]}"; do mounts+=(-v "$v"); done
  fi
  if [[ -n "$DEPLOY_DOCKER_RUN_ARGS" ]]; then
    read -r -a extra <<< "$DEPLOY_DOCKER_RUN_ARGS"
  fi

  # Para o container antigo e mantém uma cópia parada para rollback.
  if [[ "$DOCKER_CONTAINER_EXISTS" -eq 1 ]]; then
    DOCKER_OLD_CONTAINER_EXISTED=1
    local renamed="$DOCKER_CONTAINER-previous-$ts"
    log_step "Parando e preservando o container atual"
    "${DOCKER[@]}" stop "$DOCKER_CONTAINER" >/dev/null
    DOCKER_OLD_CONTAINER_STOPPED=1
    "${DOCKER[@]}" rename "$DOCKER_CONTAINER" "$renamed"
    DOCKER_OLD_CONTAINER_RENAMED="$renamed"
    log "Container anterior preservado como $DOCKER_OLD_CONTAINER_RENAMED"
  fi

  local -a cmd=("${DOCKER[@]}" run "${run_args[@]}" "${env_files[@]}" "${ports[@]}" "${mounts[@]}" "${extra[@]}")
  if [[ -n "$DEPLOY_DOCKER_CMD" ]]; then
    read -r -a docker_cmd <<< "$DEPLOY_DOCKER_CMD"
    cmd+=("$DOCKER_NEW_IMAGE" "${docker_cmd[@]}")
  else
    cmd+=("$DOCKER_NEW_IMAGE")
  fi

  RESTART_STARTED=1
  log "Iniciando novo container..."
  if ! "${cmd[@]}"; then
    die "Falha ao iniciar o novo container Docker."
  fi
  DOCKER_NEW_CONTAINER_STARTED=1
  YTDLP_UPDATED=1

  health_and_validate
}

docker_rollback() {
  log_warn "Tentando rollback do container Docker..."

  # O container antigo pode não ter sido tocado (falha antes do stop) ou ter
  # sido parado mas ainda não renomeado (falha no rename).
  if [[ "$DOCKER_OLD_CONTAINER_EXISTED" -eq 1 && -z "$DOCKER_OLD_CONTAINER_RENAMED" ]]; then
    if [[ "$DOCKER_OLD_CONTAINER_STOPPED" -eq 0 ]]; then
      log "O container anterior não foi alterado; runtime permanece intacto."
      return 0
    fi
    log_warn "O container anterior foi parado, mas não renomeado; reiniciando..."
    if "${DOCKER[@]}" start "$DOCKER_CONTAINER" >/dev/null 2>&1; then
      build_health_urls
      if [[ "${#HEALTH_URLS[@]}" -gt 0 ]]; then
        http_health "${HEALTH_URLS[0]}" 45 && return 0
      elif docker_exec_health 45; then
        return 0
      fi
    fi
    log_error "Falha ao reiniciar o container anterior."
    return 1
  fi

  # Primeiro deploy sem container anterior: remove o novo, se tiver sido criado.
  if [[ "$DOCKER_OLD_CONTAINER_EXISTED" -eq 0 && "$DOCKER_NEW_CONTAINER_STARTED" -eq 1 ]]; then
    if "${DOCKER[@]}" stop "$DOCKER_CONTAINER" >/dev/null 2>&1 && "${DOCKER[@]}" rm "$DOCKER_CONTAINER" >/dev/null 2>&1; then
      log "Container novo removido; não havia versão anterior para restaurar."
      return 0
    fi
    log_error "Falha ao remover o container novo."
    return 1
  fi

  if [[ -n "$DOCKER_OLD_CONTAINER_RENAMED" ]] && "${DOCKER[@]}" inspect "$DOCKER_CONTAINER" >/dev/null 2>&1; then
    if ! "${DOCKER[@]}" stop "$DOCKER_CONTAINER" >/dev/null 2>&1; then
      log_error "Falha ao parar o container novo durante o rollback."
      return 1
    fi
    if ! "${DOCKER[@]}" rm "$DOCKER_CONTAINER" >/dev/null 2>&1; then
      log_error "Falha ao remover o container novo durante o rollback."
      return 1
    fi
  fi
  if [[ -n "$DOCKER_OLD_CONTAINER_RENAMED" ]] && "${DOCKER[@]}" inspect "$DOCKER_OLD_CONTAINER_RENAMED" >/dev/null 2>&1; then
    "${DOCKER[@]}" rename "$DOCKER_OLD_CONTAINER_RENAMED" "$DOCKER_CONTAINER" >/dev/null 2>&1 || true
    if "${DOCKER[@]}" start "$DOCKER_CONTAINER" >/dev/null 2>&1; then
      log "Container anterior reiniciado."
      build_health_urls
      if [[ "${#HEALTH_URLS[@]}" -gt 0 ]]; then
        if http_health "${HEALTH_URLS[0]}" 45; then
          return 0
        fi
      elif docker_exec_health 45; then
        return 0
      fi
      log_error "Container anterior iniciou, mas o health check falhou."
      return 1
    fi
  fi
  log_error "Não foi possível restaurar o container anterior."
  return 1
}

# -----------------------------------------------------------------------------
# Rollback
# -----------------------------------------------------------------------------
attempt_rollback() {
  ROLLBACK_ATTEMPTED=1
  IN_ROLLBACK=1
  trap - ERR
  set +e
  log_warn "Iniciando rollback automático (etapa com falha: $CURRENT_STEP)..."

  local ok=0

  if [[ "$METHOD" == "docker" ]]; then
    if docker_rollback; then ok=0; else ok=1; fi
    if [[ "$CODE_CHANGED" -eq 1 && -d "$APP_DIR/.git" && -n "$COMMIT_BEFORE" ]]; then
      log_warn "Restaurando worktree para $COMMIT_BEFORE (sem reset --hard)..."
      if ! git -C "$APP_DIR" switch --detach "$COMMIT_BEFORE"; then
        log_error "Falha ao restaurar o worktree para $COMMIT_BEFORE."
        ok=1
      fi
    fi
  else
    if [[ "$YTDLP_UPDATE_ATTEMPTED" -eq 1 ]]; then
      restore_ytdlp || ok=1
    fi

    if [[ "$CODE_CHANGED" -eq 1 || "$DEPS_CHANGED" -eq 1 ]]; then
      if [[ -d "$APP_DIR/.git" && -n "$COMMIT_BEFORE" ]]; then
        log_warn "Restaurando código para $COMMIT_BEFORE (worktree destacado, sem reset --hard)..."
        if ! git -C "$APP_DIR" switch --detach "$COMMIT_BEFORE"; then
          log_error "Falha ao restaurar o código para $COMMIT_BEFORE."
          ok=1
        fi
      fi
      if [[ "$DEPS_CHANGED" -eq 1 ]]; then
        log_warn "Reinstalando dependências da versão anterior..."
        if ! ( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund ); then
          log_error "Falha ao reinstalar dependências antigas."
          ok=1
        fi
      fi
    fi

    if [[ "$RESTART_STARTED" -eq 1 ]]; then
      case "$METHOD" in
        systemd) run_privileged systemctl restart "${SYSTEMD_UNITS[@]}" || ok=1 ;;
        pm2)
          local app
          for app in "${PM2_APPS[@]}"; do
            pm2 restart "$app" --update-env || ok=1
          done
          pm2 save || ok=1
          ;;
        node)
          local entry
          for entry in "${ENTRY_FILES[@]}"; do
            stop_direct_entry "$entry" || ok=1
          done
          for entry in "${ENTRY_FILES[@]}"; do
            start_direct_entry "$entry" || ok=1
          done
          ;;
      esac
      build_health_urls
      if ! http_health "${HEALTH_URLS[0]}" 45; then
        log_error "Health check da versão anterior falhou."
        ok=1
      fi
    fi

    if [[ "$YTDLP_UPDATED" -eq 1 || "$YTDLP_UPDATE_ATTEMPTED" -eq 1 ]]; then
      if ! run_runtime_check "$YTDLP_OLD_VERSION"; then
        ok=1
      fi
    fi
  fi

  if [[ "$METHOD" != "docker" && ( "$YTDLP_UPDATED" -eq 1 || "$YTDLP_UPDATE_ATTEMPTED" -eq 1 ) ]]; then
    YTDLP_NEW_VERSION="$(get_ytdlp_version 2>/dev/null || true)"
  fi

  if [[ "$ok" -eq 0 ]]; then
    ROLLBACK_RESULT="sucesso"
    log "Rollback concluído; a aplicação deve estar na versão anterior."
  else
    ROLLBACK_RESULT="falha"
    log_error "Rollback automático NÃO foi concluído com sucesso."
  fi

  IN_ROLLBACK=0
  set -e
}

# -----------------------------------------------------------------------------
# Relatório
# -----------------------------------------------------------------------------
write_report() {
  local status="$1"
  if [[ "$DRY_RUN" -eq 1 || "$REPORT_WRITTEN" -eq 1 ]]; then
    return 0
  fi
  [[ -d "$REPORT_DIR" ]] || return 0

  REPORT_WRITTEN=1
  local ts="$(date +%Y%m%d-%H%M%S)"
  local path="$REPORT_DIR/deploy-$ts-$status.json"
  local duration=$(( $(date +%s) - START_EPOCH ))
  COMMIT_AFTER="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || printf '%s' "${COMMIT_AFTER:-$COMMIT_BEFORE}")"

  cat > "$path" <<EOF
{
  "timestamp": "$(json_escape "$(date -Is)")",
  "status": "$(json_escape "$status")",
  "method": "$(json_escape "$METHOD")",
  "process": "$(json_escape "$DEPLOY_PROCESS")",
  "mode": "$(json_escape "$DEPLOY_MODE")",
  "branch": "$(json_escape "$DEPLOY_BRANCH")",
  "commit_before": "$(json_escape "$COMMIT_BEFORE")",
  "commit_after": "$(json_escape "$COMMIT_AFTER")",
  "code_changed": $CODE_CHANGED,
  "ytdlp_method": "$(json_escape "$YTDLP_METHOD")",
  "ytdlp_before": "$(json_escape "$YTDLP_OLD_VERSION")",
  "ytdlp_after": "$(json_escape "$YTDLP_NEW_VERSION")",
  "ytdlp_target": "$(json_escape "$YTDLP_TARGET_VERSION")",
  "ytdlp_updated": $YTDLP_UPDATED,
  "ffmpeg": "$(json_escape "$FFMPEG_VERSION")",
  "ffprobe": "$(json_escape "$FFPROBE_VERSION")",
  "node": "$(json_escape "$NODE_VERSION")",
  "backup_dir": "$(json_escape "$BACKUP_DIR")",
  "log_file": "$(json_escape "$LOG_FILE")",
  "health_urls": "$(json_escape "${HEALTH_URLS[*]:-}")",
  "rollback_attempted": $ROLLBACK_ATTEMPTED,
  "rollback_result": "$(json_escape "$ROLLBACK_RESULT")",
  "error_status": $ERROR_STATUS,
  "error_line": $ERROR_LINE,
  "error_step": "$(json_escape "${ERROR_STEP:-$CURRENT_STEP}")",
  "docker_old_image": "$(json_escape "$DOCKER_OLD_IMAGE_BACKUP")",
  "docker_new_image": "$(json_escape "$DOCKER_NEW_IMAGE")",
  "duration_seconds": $duration
}
EOF
  chmod 600 "$path"
  ln -sfn "$path" "$REPORT_DIR/last-$status.json"
  log "Relatório: $path"
}

print_summary() {
  local status="$1" duration=$(( $(date +%s) - START_EPOCH ))
  printf '\n'
  printf '================ RESUMO DO DEPLOY ================\n'
  printf 'Status:        %s\n' "$status"
  printf 'Método:        %s\n' "$METHOD"
  printf 'Processo:      %s\n' "$DEPLOY_PROCESS"
  printf 'Commit antes:  %s\n' "${COMMIT_BEFORE:-n/d}"
  printf 'Commit depois: %s\n' "${COMMIT_AFTER:-n/d}"
  printf 'yt-dlp antes:  %s\n' "${YTDLP_OLD_VERSION:-n/d}"
  printf 'yt-dlp depois: %s\n' "${YTDLP_NEW_VERSION:-n/d}"
  printf 'FFmpeg:        %s\n' "${FFMPEG_VERSION:-n/d}"
  printf 'ffprobe:       %s\n' "${FFPROBE_VERSION:-n/d}"
  printf 'Node:          %s\n' "${NODE_VERSION:-n/d}"
  printf 'Duração:       %ss\n' "$duration"
  if [[ -n "$BACKUP_DIR" ]]; then printf 'Backup:        %s\n' "$BACKUP_DIR"; fi
  if [[ -n "$LOG_FILE" ]]; then printf 'Log:           %s\n' "$LOG_FILE"; fi
  if [[ "$ROLLBACK_ATTEMPTED" -eq 1 ]]; then
    printf 'Rollback:      %s\n' "$ROLLBACK_RESULT"
  fi
  printf '=================================================\n'
}

print_recovery_instructions() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    return 0
  fi
  [[ -n "$BACKUP_DIR" || -n "$COMMIT_BEFORE" ]] || return 0
  printf '\n--- Recuperação manual ---\n'
  printf 'Backup: %s\n' "${BACKUP_DIR:-n/d}"
  if [[ "$METHOD" == "docker" ]]; then
    printf 'Imagem anterior preservada: %s\n' "${DOCKER_OLD_IMAGE_BACKUP:-n/d}"
    printf 'Container anterior (parado): %s\n' "${DOCKER_OLD_CONTAINER_RENAMED:-n/d}"
    printf 'Para voltar: docker stop %s; docker rm %s; docker rename %s %s; docker start %s\n' \
      "$DOCKER_CONTAINER" "$DOCKER_CONTAINER" "${DOCKER_OLD_CONTAINER_RENAMED:-<antigo>}" "$DOCKER_CONTAINER" "$DOCKER_CONTAINER"
  else
    printf 'Código anterior: %s\n' "${COMMIT_BEFORE:-n/d}"
    printf 'yt-dlp anterior: %s (método: %s)\n' "${YTDLP_OLD_VERSION:-n/d}" "${YTDLP_METHOD:-n/d}"
    printf 'Exemplo de rollback manual:\n'
    printf '  cd %q\n' "$APP_DIR"
    printf '  git switch --detach %q\n' "${COMMIT_BEFORE:-<commit>}"
    printf '  npm ci --omit=dev\n'
    case "$YTDLP_METHOD" in
      standalone) printf '  # restaurar o binário de %s/ytdlp/yt-dlp.bin\n' "${BACKUP_DIR:-<backup>}" ;;
      pip|venv) printf '  %q -m pip install --force-reinstall "yt-dlp[default,curl-cffi]==%s"\n' "${YTDLP_PYTHON:-python3}" "${YTDLP_OLD_VERSION:-<versao>}" ;;
      pipx) printf '  pipx install --force "yt-dlp[default,curl-cffi]==%s"\n' "${YTDLP_OLD_VERSION:-<versao>}" ;;
      apt) printf '  sudo apt-get install --allow-downgrades -y "yt-dlp=%s"\n' "${YTDLP_APT_OLD_VERSION:-<versao>}" ;;
    esac
  fi
  printf 'O banco de dados NÃO é restaurado automaticamente; veja o backup em %s.\n' "${BACKUP_DIR:-n/d}"
  printf 'Detalhes em docs/DEPLOY.md.\n'
  printf '%s\n' '--------------------------'
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  parse_args "$@"
  init_paths

  if [[ "$DRY_RUN" -eq 0 ]]; then
    acquire_lock
    setup_logging
    WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/isalvei-deploy.XXXXXX")"
    chmod 700 "$WORK_TMP"
  fi

  trap 'on_err $? $LINENO' ERR
  trap 'on_exit' EXIT
  trap 'interrupt_handler' INT TERM

  log "iSalvei deploy iniciado em $START_ISO"
  log "Versão alvo solicitada do yt-dlp: ${REQUESTED_YTDLP_VERSION:-última disponível}"

  setup_sudo
  preflight_common
  detect_method
  preflight_method
  setup_runtime_context
  resolve_targets
  check_network

  if [[ "$DEPLOY_MODE" != "ytdlp" || "$METHOD" == "docker" ]]; then
    check_git_state
  fi

  if [[ "$DRY_RUN" -eq 0 ]]; then
    create_backup "$(date +%Y%m%d-%H%M%S)"
  fi

  if [[ "$DEPLOY_MODE" != "ytdlp" ]]; then
    update_code
    if [[ "$CODE_CHANGED" -eq 0 && "$CODE_CHANGED_PLANNED" -eq 0 ]]; then
      log "Nenhuma alteração de código detectada."
    fi
    install_deps
    if [[ "$METHOD" != "docker" ]]; then
      run_code_checks
    elif [[ -d "$APP_DIR/node_modules" ]] && ( cd "$APP_DIR" && node -e "require('express'); require('better-sqlite3')" >/dev/null 2>&1 ); then
      # No Docker, os testes completos rodam no host quando as dependências
      # já estão instaladas; dentro da imagem rodamos os testes do deploy.
      run_code_checks
    else
      log_warn "node_modules ausente/incompatível no host; testes completos serão validados apenas dentro da imagem quando possível."
    fi
  else
    log_step "Modo somente yt-dlp: código e dependências Node.js não serão alterados"
  fi

  if [[ "$METHOD" == "docker" ]]; then
    docker_build_and_deploy "$(date +%Y%m%d-%H%M%S)"
  else
    if [[ "$DEPLOY_MODE" != "code" ]]; then
      update_ytdlp_non_docker
    fi

    if [[ "$DEPLOY_MODE" == "ytdlp" ]]; then
      if [[ -n "$SERVICE_PID" ]]; then
        build_health_urls
        if [[ "$DRY_RUN" -eq 0 ]]; then
          local url
          for url in "${HEALTH_URLS[@]}"; do
            log "Health check (sem restart): $url"
            http_health "$url" 20 || log_warn "Health check HTTP falhou em $url (o yt-dlp já foi validado)."
          done
        fi
      else
        log_warn "Nenhum serviço em execução detectado; health check HTTP ignorado (runtime check já validou yt-dlp/FFmpeg)."
      fi
    else
      restart_app
      health_and_validate
    fi
  fi

  DEPLOY_OK=1
  log "Deploy concluído com sucesso em $(( $(date +%s) - START_EPOCH ))s."
  exit 0
}

# Permite testar funções via source sem executar o deploy.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
