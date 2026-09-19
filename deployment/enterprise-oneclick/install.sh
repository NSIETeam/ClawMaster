#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH=""
MIGRATION_ARCHIVE=""
DRY_RUN=0
INSTALL_ROOT="/opt/clawmaster-enterprise"
DATA_DIR="/var/lib/clawmaster-enterprise"
CONFIG_DIR="/etc/clawmaster-enterprise"
SERVICE_UNIT="/etc/systemd/system/clawmaster-enterprise.service"
CADDY_MAIN="/etc/caddy/Caddyfile"
CADDY_FRAGMENT="/etc/caddy/clawmaster-enterprise.caddy"
LOCK_FILE="/run/lock/clawmaster-enterprise-deploy.lock"
TRANSACTION_MARKER="${INSTALL_ROOT}/.installing"
TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"

usage() {
  cat <<'EOF'
用法：
  sudo ./install.sh --config ./enterprise.env \
    [--migration /安全目录/clawmaster-enterprise-migration.tar.gz]

  ./install.sh --config ./enterprise.env \
    [--migration ...] --dry-run

边界：
  - 面向 Ubuntu 22.04/24.04 + systemd 的全新服务器迁入。
  - 已安装完全相同 release 时做幂等验收；发现不同现有安装会拒绝覆盖。
  - 不修改云安全组、DNS 或 UFW。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || clawmaster_die "--config 缺少值"
      CONFIG_PATH="$2"
      shift 2
      ;;
    --migration)
      [ "$#" -ge 2 ] || clawmaster_die "--migration 缺少值"
      MIGRATION_ARCHIVE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      clawmaster_die "未知参数：$1"
      ;;
  esac
done

[ -n "$CONFIG_PATH" ] || clawmaster_die "必须提供 --config"
clawmaster_load_config "$CONFIG_PATH"

CLAWMASTER_PUBLIC_HOST="${CLAWMASTER_PUBLIC_HOST:-}"
CLAWMASTER_PUBLIC_PORT="${CLAWMASTER_PUBLIC_PORT:-7777}"
CLAWMASTER_CADDY_MODE="${CLAWMASTER_CADDY_MODE:-managed}"
CLAWMASTER_ENTERPRISE_ADMIN_TOKEN="${CLAWMASTER_ENTERPRISE_ADMIN_TOKEN:-auto}"
CLAWMASTER_BOOTSTRAP_USERNAME="${CLAWMASTER_BOOTSTRAP_USERNAME:-admin}"
CLAWMASTER_BOOTSTRAP_PASSWORD="${CLAWMASTER_BOOTSTRAP_PASSWORD:-auto}"
CLAWMASTER_BOOTSTRAP_NAME="${CLAWMASTER_BOOTSTRAP_NAME:-系统管理员}"
CLAWMASTER_ALLOW_SMS_DISABLED="${CLAWMASTER_ALLOW_SMS_DISABLED:-0}"
CLAWMASTER_BACKUP_ENCRYPTION_KEY="${CLAWMASTER_BACKUP_ENCRYPTION_KEY:-auto}"
CLAWMASTER_BACKUP_INTERVAL_HOURS="${CLAWMASTER_BACKUP_INTERVAL_HOURS:-24}"
CLAWMASTER_BACKUP_RETENTION_DAYS="${CLAWMASTER_BACKUP_RETENTION_DAYS:-30}"
CLAWMASTER_BACKUP_MINIMUM_RETAINED="${CLAWMASTER_BACKUP_MINIMUM_RETAINED:-3}"
CLAWMASTER_BACKUP_REPLICA_DIR="${CLAWMASTER_BACKUP_REPLICA_DIR:-}"
CLAWMASTER_DISK_MIN_FREE_MB="${CLAWMASTER_DISK_MIN_FREE_MB:-2048}"
CLAWMASTER_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE="${CLAWMASTER_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE:-}"
CLAWMASTER_ATTACHMENT_ENCRYPTION_KEY_FILE="${CLAWMASTER_ATTACHMENT_ENCRYPTION_KEY_FILE:-}"
CLAWMASTER_FIELD_ENCRYPTION_KEY_FILE="${CLAWMASTER_FIELD_ENCRYPTION_KEY_FILE:-}"
CLAWMASTER_TELEMETRY_ENDPOINT="${CLAWMASTER_TELEMETRY_ENDPOINT:-}"
CLAWMASTER_TELEMETRY_RETENTION_DAYS="${CLAWMASTER_TELEMETRY_RETENTION_DAYS:-90}"
CLAWMASTER_FEDERATION_ENABLED="${CLAWMASTER_FEDERATION_ENABLED:-false}"
CLAWMASTER_FEDERATION_GATEWAY_URL="${CLAWMASTER_FEDERATION_GATEWAY_URL:-}"
CLAWMASTER_FEDERATION_DISPLAY_NAME="${CLAWMASTER_FEDERATION_DISPLAY_NAME:-}"
CLAWMASTER_FEDERATION_POLL_INTERVAL_MS="${CLAWMASTER_FEDERATION_POLL_INTERVAL_MS:-10000}"
CLAWMASTER_FEDERATION_SIGNING_KEY_FILE="${CLAWMASTER_FEDERATION_SIGNING_KEY_FILE:-}"
CLAWMASTER_DATA_CONTROLLER_NAME="${CLAWMASTER_DATA_CONTROLLER_NAME:-}"
CLAWMASTER_PRIVACY_CONTACT="${CLAWMASTER_PRIVACY_CONTACT:-}"
CLAWMASTER_LEGAL_DOCUMENTS_APPROVED="${CLAWMASTER_LEGAL_DOCUMENTS_APPROVED:-false}"
CLAWMASTER_DATA_REGION="${CLAWMASTER_DATA_REGION:-CN}"
CLAWMASTER_DATA_RESIDENCY="${CLAWMASTER_DATA_RESIDENCY:-customer_server}"
CLAWMASTER_STORAGE_VOLUME_ENCRYPTED="${CLAWMASTER_STORAGE_VOLUME_ENCRYPTED:-false}"
CLAWMASTER_CROSS_BORDER_DATA_ENABLED="${CLAWMASTER_CROSS_BORDER_DATA_ENABLED:-false}"

[[ "$CLAWMASTER_PUBLIC_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] \
  || clawmaster_die "CLAWMASTER_PUBLIC_HOST 不是合法主机名"
[[ "$CLAWMASTER_PUBLIC_PORT" =~ ^[0-9]+$ ]] \
  && [ "$CLAWMASTER_PUBLIC_PORT" -ge 1 ] \
  && [ "$CLAWMASTER_PUBLIC_PORT" -le 65535 ] \
  || clawmaster_die "CLAWMASTER_PUBLIC_PORT 必须是 1-65535"
case "$CLAWMASTER_CADDY_MODE" in
  managed|external) ;;
  *) clawmaster_die "CLAWMASTER_CADDY_MODE 只能是 managed 或 external" ;;
esac
if [ "$CLAWMASTER_CADDY_MODE" = "managed" ]; then
  [[ "$CLAWMASTER_PUBLIC_HOST" == *.* ]] \
    || clawmaster_die "managed Caddy 需要可公开签发证书的 FQDN，不能使用裸主机名或 IP"
  [[ "$CLAWMASTER_PUBLIC_HOST" =~ [A-Za-z] ]] \
    || clawmaster_die "managed Caddy 不接受裸 IP；请使用域名或选择 external"
fi

EXPECTED_PUBLIC_URL="https://${CLAWMASTER_PUBLIC_HOST}:${CLAWMASTER_PUBLIC_PORT}"
CLAWMASTER_ENTERPRISE_PUBLIC_URL="${CLAWMASTER_ENTERPRISE_PUBLIC_URL:-$EXPECTED_PUBLIC_URL}"
if [ "$CLAWMASTER_CADDY_MODE" = "managed" ] \
  && [ "$CLAWMASTER_ENTERPRISE_PUBLIC_URL" != "$EXPECTED_PUBLIC_URL" ]; then
  clawmaster_die "managed 模式下 CLAWMASTER_ENTERPRISE_PUBLIC_URL 必须为 ${EXPECTED_PUBLIC_URL}"
fi
[[ "$CLAWMASTER_ENTERPRISE_PUBLIC_URL" == https://* ]] \
  || clawmaster_die "CLAWMASTER_ENTERPRISE_PUBLIC_URL 必须使用 HTTPS"

case "$CLAWMASTER_ALLOW_SMS_DISABLED" in
  0|1) ;;
  *) clawmaster_die "CLAWMASTER_ALLOW_SMS_DISABLED 只能是 0 或 1" ;;
esac
for numeric_value in \
  "$CLAWMASTER_BACKUP_INTERVAL_HOURS" \
  "$CLAWMASTER_BACKUP_RETENTION_DAYS" \
  "$CLAWMASTER_BACKUP_MINIMUM_RETAINED" \
  "$CLAWMASTER_DISK_MIN_FREE_MB" \
  "$CLAWMASTER_TELEMETRY_RETENTION_DAYS" \
  "$CLAWMASTER_FEDERATION_POLL_INTERVAL_MS"; do
  [[ "$numeric_value" =~ ^[0-9]+$ ]] && [ "$numeric_value" -ge 1 ] \
    || clawmaster_die "备份周期、保留策略和磁盘阈值必须是正整数"
done
case "$CLAWMASTER_FEDERATION_ENABLED" in
  true|false) ;;
  *) clawmaster_die "CLAWMASTER_FEDERATION_ENABLED 只能是 true 或 false" ;;
esac
if [ "$CLAWMASTER_FEDERATION_POLL_INTERVAL_MS" -lt 2000 ]; then
  clawmaster_die "CLAWMASTER_FEDERATION_POLL_INTERVAL_MS 不能小于 2000"
fi
if [ "$CLAWMASTER_FEDERATION_ENABLED" = "true" ]; then
  case "$CLAWMASTER_FEDERATION_GATEWAY_URL" in
    https://*) ;;
    *) clawmaster_die "启用联邦网关时 CLAWMASTER_FEDERATION_GATEWAY_URL 必须使用 HTTPS" ;;
  esac
fi
if [ -n "$CLAWMASTER_FEDERATION_SIGNING_KEY_FILE" ]; then
  [[ "$CLAWMASTER_FEDERATION_SIGNING_KEY_FILE" = /* ]] \
    || clawmaster_die "CLAWMASTER_FEDERATION_SIGNING_KEY_FILE 必须使用绝对路径"
  [ -f "$CLAWMASTER_FEDERATION_SIGNING_KEY_FILE" ] \
    && [ ! -L "$CLAWMASTER_FEDERATION_SIGNING_KEY_FILE" ] \
    || clawmaster_die "CLAWMASTER_FEDERATION_SIGNING_KEY_FILE 必须指向普通文件且不能是符号链接"
  grep -Fq 'BEGIN PRIVATE KEY' "$CLAWMASTER_FEDERATION_SIGNING_KEY_FILE" \
    || clawmaster_die "联邦签名私钥必须是 PKCS#8 PEM"
fi
case "$CLAWMASTER_CROSS_BORDER_DATA_ENABLED" in
  true|false) ;;
  *) clawmaster_die "CLAWMASTER_CROSS_BORDER_DATA_ENABLED 只能是 true 或 false" ;;
esac
case "$CLAWMASTER_STORAGE_VOLUME_ENCRYPTED" in
  true|false) ;;
  *) clawmaster_die "CLAWMASTER_STORAGE_VOLUME_ENCRYPTED 只能是 true 或 false" ;;
esac
case "$CLAWMASTER_LEGAL_DOCUMENTS_APPROVED" in
  true|false) ;;
  *) clawmaster_die "CLAWMASTER_LEGAL_DOCUMENTS_APPROVED 只能是 true 或 false" ;;
esac
if [ -n "$CLAWMASTER_BACKUP_REPLICA_DIR" ] \
  && [ "$CLAWMASTER_BACKUP_REPLICA_DIR" != "/var/backups/clawmaster-enterprise" ]; then
  clawmaster_die "一键部署的异地备份挂载点固定为 /var/backups/clawmaster-enterprise"
fi
case "$CLAWMASTER_TELEMETRY_ENDPOINT" in
  ""|https://*) ;;
  *) clawmaster_die "CLAWMASTER_TELEMETRY_ENDPOINT 必须为空或使用 HTTPS" ;;
esac
for key_variable in \
  CLAWMASTER_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE \
  CLAWMASTER_ATTACHMENT_ENCRYPTION_KEY_FILE \
  CLAWMASTER_FIELD_ENCRYPTION_KEY_FILE; do
  key_path="${!key_variable}"
  [ -z "$key_path" ] && continue
  [[ "$key_path" = /* ]] || clawmaster_die "${key_variable} 必须使用绝对路径"
  [ -f "$key_path" ] && [ ! -L "$key_path" ] \
    || clawmaster_die "${key_variable} 必须指向已存在的普通文件，且不能是符号链接"
  [ "$(wc -c < "$key_path")" -eq 32 ] \
    || clawmaster_die "${key_variable} 必须包含恰好 32 字节原始密钥"
done
if [ "$CLAWMASTER_ALLOW_SMS_DISABLED" = "0" ]; then
  for key in \
    ALIYUN_SMS_ACCESS_KEY_ID \
    ALIYUN_SMS_ACCESS_KEY_SECRET \
    ALIYUN_SMS_SIGN_NAME \
    ALIYUN_SMS_TEMPLATE_ID; do
    value="${!key:-}"
    [ -n "$value" ] && [ "$value" != "REPLACE_ME" ] \
      || clawmaster_die "${key} 未配置；邀请码注册依赖短信，正式迁移默认 fail closed"
  done
fi

[ -d "${SCRIPT_DIR}/release" ] || clawmaster_die "部署包缺少 release 目录" 3
[ -f "${SCRIPT_DIR}/release/manifest.json" ] || clawmaster_die "部署包缺少 release manifest" 3
[ -f "${SCRIPT_DIR}/tools/db-tool.mjs" ] || clawmaster_die "部署包缺少数据库工具" 3
clawmaster_verify_package_manifest "$SCRIPT_DIR"

if [ -n "$MIGRATION_ARCHIVE" ]; then
  case "$MIGRATION_ARCHIVE" in
    /*) ;;
    *) clawmaster_die "--migration 必须是绝对路径" ;;
  esac
  [ -f "$MIGRATION_ARCHIVE" ] || clawmaster_die "迁移包不存在：${MIGRATION_ARCHIVE}" 3
  [ ! -L "$MIGRATION_ARCHIVE" ] || clawmaster_die "迁移包不能是符号链接" 3
fi

if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(id -u)" -eq 0 ] || clawmaster_die "正式安装必须使用 sudo/root" 3
  [ "$(uname -s)" = "Linux" ] || clawmaster_die "正式安装仅支持 Linux" 3
  [ -r /etc/os-release ] || clawmaster_die "无法识别 Linux 发行版" 3
  # shellcheck disable=SC1091
  source /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || clawmaster_die "仅支持 Ubuntu，当前为 ${ID:-unknown}" 3
  case "${VERSION_ID:-}" in
    22.04|24.04) ;;
    *) clawmaster_die "仅支持 Ubuntu 22.04/24.04，当前为 ${VERSION_ID:-unknown}" 3 ;;
  esac
  command -v systemctl >/dev/null 2>&1 || clawmaster_die "目标机没有 systemd" 3
  mkdir -p "$(dirname -- "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  flock -n 9 || clawmaster_die "已有另一个 ClawMaster 部署正在运行" 3
fi

clawmaster_arch >/dev/null
if [ "$CLAWMASTER_CADDY_MODE" = "managed" ] && command -v getent >/dev/null 2>&1; then
  getent ahosts "$CLAWMASTER_PUBLIC_HOST" >/dev/null 2>&1 \
    || clawmaster_die "域名当前无法解析：${CLAWMASTER_PUBLIC_HOST}" 3
fi

AVAILABLE_KB="$(df -Pk / | awk 'NR==2 {print $4}')"
MIGRATION_KB=0
if [ -n "$MIGRATION_ARCHIVE" ]; then
  MIGRATION_KB="$(( ($(stat -c %s "$MIGRATION_ARCHIVE" 2>/dev/null || stat -f %z "$MIGRATION_ARCHIVE") + 1023) / 1024 ))"
fi
REQUIRED_KB="$((524288 + MIGRATION_KB * 4))"
[ "$AVAILABLE_KB" -ge "$REQUIRED_KB" ] \
  || clawmaster_die "磁盘不足：至少需要 ${REQUIRED_KB} KiB，可用 ${AVAILABLE_KB} KiB" 3

clawmaster_log "部署计划"
printf '  目标：Ubuntu %s / %s\n' "${VERSION_ID:-dry-run}" "$(uname -m)"
printf '  公网：%s\n  代理：%s\n' "$CLAWMASTER_ENTERPRISE_PUBLIC_URL" "$CLAWMASTER_CADDY_MODE"
printf '  数据：%s\n' "$([ -n "$MIGRATION_ARCHIVE" ] && printf '迁移包 %s' "$MIGRATION_ARCHIVE" || printf '新建空库')"
printf '  短信：%s\n' "$([ "$CLAWMASTER_ALLOW_SMS_DISABLED" = "1" ] && printf '允许暂时关闭' || printf '必须可配置')"
printf '  自动写入：%s、%s、%s\n' "$INSTALL_ROOT" "$CONFIG_DIR" "$SERVICE_UNIT"
printf '  不会修改：DNS、云安全组、UFW\n'

[ ! -e "$TRANSACTION_MARKER" ] && [ ! -L "$TRANSACTION_MARKER" ] \
  || clawmaster_die "发现未完成安装标记：${TRANSACTION_MARKER}。请先检查 systemd、current、data.db 和失败事务目录，再按说明恢复" 3

CURRENT_EXISTS=0
CURRENT_REAL=""
if [ -e "${INSTALL_ROOT}/current" ] || [ -L "${INSTALL_ROOT}/current" ]; then
  CURRENT_EXISTS=1
  [ -L "${INSTALL_ROOT}/current" ] \
    || clawmaster_die "${INSTALL_ROOT}/current 必须是符号链接，拒绝覆盖现有路径" 3
  CURRENT_REAL="$(readlink -f "${INSTALL_ROOT}/current")"
  [ -d "$CURRENT_REAL" ] \
    || clawmaster_die "current 指向不存在或不是目录：${CURRENT_REAL}" 3
  [ -x "${INSTALL_ROOT}/runtime/current/bin/node" ] \
    || clawmaster_die "现有安装缺少固定 Node runtime，拒绝修改" 3
else
  if [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; then
    [ -d "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ] \
      || clawmaster_die "安装根路径不是普通目录：${INSTALL_ROOT}" 3
    [ -z "$(find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ] \
      || clawmaster_die "发现没有 current 管理的安装根内容，拒绝覆盖：${INSTALL_ROOT}" 3
  fi
  [ ! -e "${DATA_DIR}/data.db" ] \
    || clawmaster_die "发现未受 current release 管理的现有数据库，拒绝覆盖：${DATA_DIR}/data.db" 3
  [ ! -e "${CONFIG_DIR}/enterprise.env" ] && [ ! -L "${CONFIG_DIR}/enterprise.env" ] \
    || clawmaster_die "发现未受 current release 管理的现有配置，拒绝覆盖：${CONFIG_DIR}/enterprise.env" 3
  [ ! -e "$SERVICE_UNIT" ] && [ ! -L "$SERVICE_UNIT" ] \
    || clawmaster_die "发现未受 current release 管理的 systemd 单元，拒绝覆盖：${SERVICE_UNIT}" 3
  if [ "$CLAWMASTER_CADDY_MODE" = "managed" ]; then
    [ ! -e "$CADDY_FRAGMENT" ] && [ ! -L "$CADDY_FRAGMENT" ] \
      || clawmaster_die "发现现有 ClawMaster Caddy 片段，拒绝覆盖：${CADDY_FRAGMENT}" 3
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  TXN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawmaster-enterprise-dry-run.XXXXXX")"
else
  TXN_DIR="/var/tmp/clawmaster-enterprise-deploy-${TRANSACTION_ID}"
  mkdir -p "$TXN_DIR"
fi
chmod 0700 "$TXN_DIR"
INSTALL_COMMITTED=0
CREATED_SERVICE=0
TARGET_RELEASE=""
TARGET_RELEASE_CREATED=0
DEPLOY_CREATED=0
CURRENT_CREATED=0
DATA_CREATED=0
CONFIG_CREATED=0
RUNTIME_LINK_CREATED=0
RUNTIME_DIR_CREATED=0
TRANSACTION_MARKER_CREATED=0
INSTALL_ROOT_CREATED=0
NODE_RUNTIME_DIR=""
CANARY_PID=""
CADDY_MAIN_BACKUP=""
CADDY_FRAGMENT_BACKUP=""

cleanup() {
  local status=$?
  if [ -n "$CANARY_PID" ] && kill -0 "$CANARY_PID" >/dev/null 2>&1; then
    kill -TERM "$CANARY_PID" >/dev/null 2>&1 || true
    wait "$CANARY_PID" || true
  fi
  if [ "$status" -ne 0 ] && [ "$INSTALL_COMMITTED" -eq 0 ]; then
    clawmaster_warn "安装未提交，保留已迁移数据库副本供排查：${TXN_DIR}"
    if [ "$CREATED_SERVICE" -eq 1 ]; then
      systemctl disable --now clawmaster-enterprise >/dev/null 2>&1 || true
      if [ -f "$SERVICE_UNIT" ]; then
        mv "$SERVICE_UNIT" "${TXN_DIR}/failed-clawmaster-enterprise.service"
        systemctl daemon-reload >/dev/null 2>&1 || true
      fi
    fi
    if [ "$CURRENT_CREATED" -eq 1 ] && [ -L "${INSTALL_ROOT}/current" ]; then
      mv "${INSTALL_ROOT}/current" "${TXN_DIR}/failed-current-link"
    fi
    if [ "$TARGET_RELEASE_CREATED" -eq 1 ] \
      && [ -n "$TARGET_RELEASE" ] \
      && [ -d "$TARGET_RELEASE" ]; then
      mv "$TARGET_RELEASE" "${TXN_DIR}/failed-release"
    fi
    if [ "$DEPLOY_CREATED" -eq 1 ] && [ -d "${INSTALL_ROOT}/deploy" ]; then
      mv "${INSTALL_ROOT}/deploy" "${TXN_DIR}/failed-deploy-tools"
    fi
    if [ "$DATA_CREATED" -eq 1 ] && [ -f "${DATA_DIR}/data.db" ]; then
      mv "${DATA_DIR}/data.db" "${TXN_DIR}/failed-data.db"
    fi
    if [ "$CONFIG_CREATED" -eq 1 ] && [ -f "${CONFIG_DIR}/enterprise.env" ]; then
      mv "${CONFIG_DIR}/enterprise.env" "${TXN_DIR}/failed-enterprise.env"
    fi
    if [ "$RUNTIME_LINK_CREATED" -eq 1 ] && [ -L "${INSTALL_ROOT}/runtime/current" ]; then
      mv "${INSTALL_ROOT}/runtime/current" "${TXN_DIR}/failed-runtime-link"
    fi
    if [ "$RUNTIME_DIR_CREATED" -eq 1 ] \
      && [ -n "$NODE_RUNTIME_DIR" ] \
      && [ -d "$NODE_RUNTIME_DIR" ]; then
      mv "$NODE_RUNTIME_DIR" "${TXN_DIR}/failed-node-runtime"
    fi
    if [ "$TRANSACTION_MARKER_CREATED" -eq 1 ] && [ -f "$TRANSACTION_MARKER" ]; then
      mv "$TRANSACTION_MARKER" "${TXN_DIR}/failed-installing-marker"
    fi
    rmdir "${INSTALL_ROOT}/releases" "${INSTALL_ROOT}/runtime" >/dev/null 2>&1 || true
    if [ "$INSTALL_ROOT_CREATED" -eq 1 ]; then
      rmdir "$INSTALL_ROOT" >/dev/null 2>&1 || true
    fi
    if [ -n "$CADDY_MAIN_BACKUP" ] && [ -f "$CADDY_MAIN_BACKUP" ]; then
      cp -p "$CADDY_MAIN_BACKUP" "$CADDY_MAIN"
    fi
    if [ -n "$CADDY_FRAGMENT_BACKUP" ] && [ -f "$CADDY_FRAGMENT_BACKUP" ]; then
      cp -p "$CADDY_FRAGMENT_BACKUP" "$CADDY_FRAGMENT"
    elif [ -f "$CADDY_FRAGMENT" ] && [ -f "${TXN_DIR}/created-caddy-fragment" ]; then
      mv "$CADDY_FRAGMENT" "${TXN_DIR}/failed-caddy-fragment"
    fi
    if command -v caddy >/dev/null 2>&1 && [ -f "$CADDY_MAIN" ]; then
      caddy validate --config "$CADDY_MAIN" --adapter caddyfile >/dev/null 2>&1 \
        && systemctl reload caddy >/dev/null 2>&1 || true
    fi
  elif [ "$status" -eq 0 ]; then
    rm -rf "$TXN_DIR"
  fi
}
trap cleanup EXIT

PREFERRED_NODE=""
if [ "$CURRENT_EXISTS" -eq 1 ]; then
  PREFERRED_NODE="${INSTALL_ROOT}/runtime/current/bin/node"
fi
if ! NODE_PATH="$(clawmaster_resolve_node "$PREFERRED_NODE")"; then
  if ! command -v curl >/dev/null 2>&1 \
    || [ ! -r /etc/ssl/certs/ca-certificates.crt ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      clawmaster_die "dry-run 深度校验需要 Node >= ${CLAWMASTER_NODE_MIN_VERSION}，或预先安装 curl 与 ca-certificates 以下载临时固定 runtime" 3
    fi
    clawmaster_log "安装深度校验所需的 curl 与 CA 证书"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl
  fi
  NODE_PATH="$(clawmaster_install_node_runtime "${TXN_DIR}/runtime")"
fi

RELEASE_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" "${SCRIPT_DIR}/release")"
RELEASE_VERSION="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.version)" "$RELEASE_INFO")"
BUILD_ID="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.buildCommit)" "$RELEASE_INFO")"
RELEASE_SCHEMA_TO="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.database.schemaTo)" "$RELEASE_INFO")"
RELEASE_NAME="${RELEASE_VERSION}-${BUILD_ID:0:12}"
TARGET_RELEASE="${INSTALL_ROOT}/releases/${RELEASE_NAME}"

if [ "$CURRENT_EXISTS" -eq 1 ]; then
  CURRENT_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" "$CURRENT_REAL")"
  CURRENT_BUILD="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.buildCommit)" "$CURRENT_INFO")"
  if [ "$CURRENT_BUILD" = "$BUILD_ID" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      clawmaster_log "dry-run 通过：相同 release 已安装；未写入或重启"
    else
      clawmaster_log "相同 release 已安装；不备份、不重启，直接执行幂等验收"
      CLAWMASTER_ALLOW_SMS_DISABLED="$CLAWMASTER_ALLOW_SMS_DISABLED" "${SCRIPT_DIR}/verify.sh"
    fi
    INSTALL_COMMITTED=1
    exit 0
  fi
  clawmaster_die "检测到不同的现有 ClawMaster release，迁入包拒绝覆盖。请先走专门升级/回滚流程" 3
fi

MIGRATION_DB=""
if [ -n "$MIGRATION_ARCHIVE" ]; then
  STAGED_MIGRATION="${TXN_DIR}/migration.tar.gz"
  cp "$MIGRATION_ARCHIVE" "$STAGED_MIGRATION"
  chmod 0600 "$STAGED_MIGRATION"
  ACTUAL_ARCHIVE_SHA="$(clawmaster_sha256 "$STAGED_MIGRATION")"
  if [ -f "${MIGRATION_ARCHIVE}.sha256" ]; then
    EXPECTED_ARCHIVE_SHA="$(awk 'NR==1 {print $1}' "${MIGRATION_ARCHIVE}.sha256")"
    [[ "$EXPECTED_ARCHIVE_SHA" =~ ^[a-f0-9]{64}$ ]] \
      || clawmaster_die "迁移包旁路 SHA-256 格式无效" 5
    [ "$EXPECTED_ARCHIVE_SHA" = "$ACTUAL_ARCHIVE_SHA" ] \
      || clawmaster_die "迁移包 SHA-256 与旁路校验文件不一致" 5
  else
    clawmaster_warn "迁移包旁边没有 .sha256；仍会校验包内数据库 hash"
  fi

  ARCHIVE_LIST="${TXN_DIR}/migration-entries.txt"
  ARCHIVE_VERBOSE="${TXN_DIR}/migration-entries.verbose.txt"
  tar -tzf "$STAGED_MIGRATION" > "$ARCHIVE_LIST"
  tar --numeric-owner -tvzf "$STAGED_MIGRATION" > "$ARCHIVE_VERBOSE"
  while IFS= read -r entry; do
    case "$entry" in
      migration/|migration/data.db|migration/manifest.json) ;;
      *) clawmaster_die "迁移包包含不允许的路径：${entry}" 5 ;;
    esac
  done < "$ARCHIVE_LIST"
  [ "$(wc -l < "$ARCHIVE_LIST" | tr -d '[:space:]')" = "3" ] \
    && [ "$(awk '$0=="migration/" {n++} END {print n+0}' "$ARCHIVE_LIST")" = "1" ] \
    && [ "$(awk '$0=="migration/data.db" {n++} END {print n+0}' "$ARCHIVE_LIST")" = "1" ] \
    && [ "$(awk '$0=="migration/manifest.json" {n++} END {print n+0}' "$ARCHIVE_LIST")" = "1" ] \
    || clawmaster_die "迁移包必须且只能包含一个目录、一个 data.db 和一个 manifest.json" 5
  if awk 'substr($1,1,1)!="d" && substr($1,1,1)!="-" {bad=1} END {exit !bad}' \
    "$ARCHIVE_VERBOSE"; then
    clawmaster_die "迁移包包含非常规文件、链接或设备节点" 5
  fi
  DB_UNCOMPRESSED_SIZE="$(awk '$NF=="migration/data.db" {print (NF >= 9 ? $5 : $3)}' "$ARCHIVE_VERBOSE")"
  MANIFEST_UNCOMPRESSED_SIZE="$(awk '$NF=="migration/manifest.json" {print (NF >= 9 ? $5 : $3)}' "$ARCHIVE_VERBOSE")"
  [[ "$DB_UNCOMPRESSED_SIZE" =~ ^[0-9]+$ ]] \
    && [ "$DB_UNCOMPRESSED_SIZE" -gt 0 ] \
    || clawmaster_die "迁移数据库的归档尺寸无效" 5
  [[ "$MANIFEST_UNCOMPRESSED_SIZE" =~ ^[0-9]+$ ]] \
    && [ "$MANIFEST_UNCOMPRESSED_SIZE" -gt 0 ] \
    && [ "$MANIFEST_UNCOMPRESSED_SIZE" -le 1048576 ] \
    || clawmaster_die "迁移 manifest 为空或超过 1 MiB" 5
  REQUIRED_IMPORT_BYTES="$((DB_UNCOMPRESSED_SIZE * 4 + 536870912))"
  AVAILABLE_BYTES="$((AVAILABLE_KB * 1024))"
  [ "$REQUIRED_IMPORT_BYTES" -le "$AVAILABLE_BYTES" ] \
    || clawmaster_die "迁移数据库解压后空间不足：预计至少需要 ${REQUIRED_IMPORT_BYTES} 字节" 5
  mkdir -p "${TXN_DIR}/import"
  tar -xzf "$STAGED_MIGRATION" -C "${TXN_DIR}/import"
  MIGRATION_DB="${TXN_DIR}/import/migration/data.db"
  MIGRATION_MANIFEST="${TXN_DIR}/import/migration/manifest.json"
  [ -f "$MIGRATION_DB" ] && [ -f "$MIGRATION_MANIFEST" ] \
    || clawmaster_die "迁移包缺少 data.db 或 manifest.json" 5
  [ ! -L "$MIGRATION_DB" ] && [ ! -L "$MIGRATION_MANIFEST" ] \
    || clawmaster_die "迁移包解压后包含符号链接" 5
  ACTUAL_DB_SIZE="$(stat -c %s "$MIGRATION_DB" 2>/dev/null || stat -f %z "$MIGRATION_DB")"
  ACTUAL_MANIFEST_SIZE="$(stat -c %s "$MIGRATION_MANIFEST" 2>/dev/null || stat -f %z "$MIGRATION_MANIFEST")"
  [ "$ACTUAL_DB_SIZE" = "$DB_UNCOMPRESSED_SIZE" ] \
    && [ "$ACTUAL_MANIFEST_SIZE" = "$MANIFEST_UNCOMPRESSED_SIZE" ] \
    || clawmaster_die "迁移包声明尺寸与解压结果不一致" 5
  "$NODE_PATH" --input-type=module - "$MIGRATION_MANIFEST" <<'NODE'
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (
  manifest.format !== 'clawmaster-enterprise-migration-v1'
  || !/^[a-f0-9]{64}$/.test(manifest.database?.sha256 ?? '')
) {
  throw new Error('migration manifest format/hash is invalid');
}
NODE
  IMPORT_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" inspect "$MIGRATION_DB")"
  IMPORT_SCHEMA="$("$NODE_PATH" -e \
    "const x=JSON.parse(process.argv[1]);console.log(x.userVersion)" "$IMPORT_INFO")"
  [ "$IMPORT_SCHEMA" -ge 2 ] && [ "$IMPORT_SCHEMA" -le "$RELEASE_SCHEMA_TO" ] \
    || clawmaster_die "本迁入包只接受 schema 2 至 ${RELEASE_SCHEMA_TO}，迁移包为 schema ${IMPORT_SCHEMA}；请先在旧服务器走受控升级" 5
  EXPECTED_DB_SHA="$("$NODE_PATH" -e \
    "const x=require(process.argv[1]);console.log(x.database.sha256)" "$MIGRATION_MANIFEST")"
  ACTUAL_DB_SHA="$("$NODE_PATH" -e \
    "const x=JSON.parse(process.argv[1]);console.log(x.sha256)" "$IMPORT_INFO")"
  [ "$EXPECTED_DB_SHA" = "$ACTUAL_DB_SHA" ] \
    || clawmaster_die "迁移包内数据库 SHA-256 与 manifest 不一致" 5
fi

CANARY_DIR="${TXN_DIR}/canary"
mkdir -p "$CANARY_DIR"
if [ -n "$MIGRATION_DB" ]; then
  cp "$MIGRATION_DB" "${CANARY_DIR}/data.db"
fi

export CLAWMASTER_ENTERPRISE_DIR="$CANARY_DIR"
export CLAWMASTER_ENTERPRISE_HOST="127.0.0.1"
export CLAWMASTER_ENTERPRISE_PORT="17777"
export CLAWMASTER_ENTERPRISE_PUBLIC_URL
export CLAWMASTER_ENTERPRISE_ADMIN_TOKEN
export CLAWMASTER_ENTERPRISE_TRUST_PROXY_HOPS="1"
export CLAWMASTER_APP_VERSION="$RELEASE_VERSION"
export CLAWMASTER_BUILD_COMMIT="$BUILD_ID"
export ALIYUN_SMS_PROVIDER="${ALIYUN_SMS_PROVIDER:-pnvs}"

"$NODE_PATH" "${SCRIPT_DIR}/tools/migrate-check.mjs" "${SCRIPT_DIR}/release" "$CANARY_DIR"
MIGRATED_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" inspect "${CANARY_DIR}/data.db")"
if [ -n "$MIGRATION_DB" ]; then
  "$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" \
    compare "$MIGRATION_DB" "${CANARY_DIR}/data.db" >/dev/null
fi

ACCOUNT_COUNT="$("$NODE_PATH" -e \
  "const x=JSON.parse(process.argv[1]);console.log(x.rowCounts.accounts||0)" "$MIGRATED_INFO")"
if [ "$CLAWMASTER_ENTERPRISE_ADMIN_TOKEN" != "auto" ]; then
  [ "${#CLAWMASTER_ENTERPRISE_ADMIN_TOKEN}" -ge 32 ] \
    || clawmaster_die "CLAWMASTER_ENTERPRISE_ADMIN_TOKEN 至少 32 个字符" 3
fi
if [ "$ACCOUNT_COUNT" -eq 0 ] && [ "$CLAWMASTER_BOOTSTRAP_PASSWORD" != "auto" ]; then
  [ "${#CLAWMASTER_BOOTSTRAP_PASSWORD}" -ge 8 ] \
    || clawmaster_die "空库的 CLAWMASTER_BOOTSTRAP_PASSWORD 至少 8 个字符" 3
fi

if [ "$DRY_RUN" -eq 1 ]; then
  clawmaster_log "dry-run 深度校验通过：包清单、release、迁移归档、SQLite、schema 与数据对账均通过"
  printf '  迁移后账号数：%s\n' "$ACCOUNT_COUNT"
  clawmaster_log "未创建用户，未写 /etc、/opt 或 /var/lib，未启动或重启服务"
  exit 0
fi

if [ ! -d "$INSTALL_ROOT" ]; then
  mkdir -p "$INSTALL_ROOT"
  INSTALL_ROOT_CREATED=1
fi
TRANSACTION_MARKER_CREATED=1
printf 'transaction=%s\nbuild=%s\nstartedAt=%s\n' \
  "$TRANSACTION_ID" "$BUILD_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$TRANSACTION_MARKER"
chmod 0600 "$TRANSACTION_MARKER"

if ! command -v curl >/dev/null 2>&1 \
  || [ ! -r /etc/ssl/certs/ca-certificates.crt ]; then
  clawmaster_log "安装固定 Node.js runtime 所需的 curl 与 CA 证书"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl
fi

RUNTIME_ARCH="$(clawmaster_arch)"
TEMP_RUNTIME_DIR="${TXN_DIR}/runtime/node-v${CLAWMASTER_NODE_VERSION}-linux-${RUNTIME_ARCH}"
mkdir -p "${INSTALL_ROOT}/runtime"
NODE_RUNTIME_DIR="${INSTALL_ROOT}/runtime/node-v${CLAWMASTER_NODE_VERSION}-linux-${RUNTIME_ARCH}"
RUNTIME_DIR_CREATED=1
if [ -x "${TEMP_RUNTIME_DIR}/bin/node" ]; then
  cp -a "$TEMP_RUNTIME_DIR" "${INSTALL_ROOT}/runtime/"
  NODE_PATH="${INSTALL_ROOT}/runtime/$(basename -- "$TEMP_RUNTIME_DIR")/bin/node"
else
  NODE_PATH="$(clawmaster_install_node_runtime "${INSTALL_ROOT}/runtime")"
fi
NODE_RUNTIME_DIR="$(dirname -- "$(dirname -- "$NODE_PATH")")"
[ "$("$NODE_PATH" --version)" = "v${CLAWMASTER_NODE_VERSION}" ] \
  || clawmaster_die "安装后的固定 Node runtime 版本不正确" 3
[ ! -e "${INSTALL_ROOT}/runtime/current" ] \
  && [ ! -L "${INSTALL_ROOT}/runtime/current" ] \
  || clawmaster_die "runtime/current 已存在，拒绝覆盖" 3
ln -s "$NODE_RUNTIME_DIR" "${INSTALL_ROOT}/runtime/current"
RUNTIME_LINK_CREATED=1

mkdir -p "${INSTALL_ROOT}/releases"
if [ -e "$TARGET_RELEASE" ] || [ -L "$TARGET_RELEASE" ]; then
  clawmaster_die "目标 release 目录已存在但未被 current 管理：${TARGET_RELEASE}" 3
fi
cp -a "${SCRIPT_DIR}/release" "$TARGET_RELEASE"
TARGET_RELEASE_CREATED=1
chown root:root "$INSTALL_ROOT" "${INSTALL_ROOT}/runtime" "${INSTALL_ROOT}/releases"
chown -R root:root "${INSTALL_ROOT}/runtime" "$TARGET_RELEASE"
clawmaster_prepare_service_layout "$INSTALL_ROOT" "$TARGET_RELEASE"
"$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" "$TARGET_RELEASE" >/dev/null
export CLAWMASTER_LICENSE_TRUST_FILE="${TARGET_RELEASE}/license-public-keys.json"

mkdir -p "${INSTALL_ROOT}/deploy"
DEPLOY_CREATED=1
cp -a "${SCRIPT_DIR}/tools" "${INSTALL_ROOT}/deploy/"
cp -a "${SCRIPT_DIR}/lib" "${INSTALL_ROOT}/deploy/"
cp -a "${SCRIPT_DIR}/verify.sh" "${INSTALL_ROOT}/deploy/verify.sh"
cp -a "${SCRIPT_DIR}/backup-now.sh" "${INSTALL_ROOT}/deploy/backup-now.sh"
cp -a "${SCRIPT_DIR}/restore-backup.sh" "${INSTALL_ROOT}/deploy/restore-backup.sh"
chmod 755 \
  "${INSTALL_ROOT}/deploy/verify.sh" \
  "${INSTALL_ROOT}/deploy/backup-now.sh" \
  "${INSTALL_ROOT}/deploy/restore-backup.sh"

if [ "$CLAWMASTER_ENTERPRISE_ADMIN_TOKEN" = "auto" ]; then
  CLAWMASTER_ENTERPRISE_ADMIN_TOKEN="$(clawmaster_random_secret "$NODE_PATH")"
fi
if [ "$CLAWMASTER_BACKUP_ENCRYPTION_KEY" = "auto" ]; then
  CLAWMASTER_BACKUP_ENCRYPTION_KEY="$($NODE_PATH --input-type=module -e \
    "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64'))")"
fi
"$NODE_PATH" --input-type=module -e \
  "const value = process.argv[1]; const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64'); if (key.length !== 32) process.exit(1)" \
  "$CLAWMASTER_BACKUP_ENCRYPTION_KEY" \
  || clawmaster_die "CLAWMASTER_BACKUP_ENCRYPTION_KEY 必须是 32 字节 Base64 或 64 位十六进制密钥"
[ "${#CLAWMASTER_ENTERPRISE_ADMIN_TOKEN}" -ge 32 ] \
  || clawmaster_die "CLAWMASTER_ENTERPRISE_ADMIN_TOKEN 至少 32 个字符"
export CLAWMASTER_ENTERPRISE_ADMIN_TOKEN

if [ "$ACCOUNT_COUNT" -eq 0 ]; then
  clawmaster_log "迁移库没有账号，创建首个管理员"
  if [ "$CLAWMASTER_BOOTSTRAP_PASSWORD" = "auto" ]; then
    CLAWMASTER_BOOTSTRAP_PASSWORD="$(clawmaster_random_secret "$NODE_PATH")"
    BOOTSTRAP_CREDENTIALS="${TXN_DIR}/bootstrap-credentials.txt"
    printf 'username=%s\npassword=%s\n' \
      "$CLAWMASTER_BOOTSTRAP_USERNAME" "$CLAWMASTER_BOOTSTRAP_PASSWORD" > "$BOOTSTRAP_CREDENTIALS"
    chmod 600 "$BOOTSTRAP_CREDENTIALS"
  fi
  [ "${#CLAWMASTER_BOOTSTRAP_PASSWORD}" -ge 8 ] \
    || clawmaster_die "CLAWMASTER_BOOTSTRAP_PASSWORD 至少 8 个字符"
  export CLAWMASTER_BOOTSTRAP_USERNAME CLAWMASTER_BOOTSTRAP_PASSWORD CLAWMASTER_BOOTSTRAP_NAME
  "$NODE_PATH" "${TARGET_RELEASE}/src/enterprise/bin.js" --bootstrap-admin
  "$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" inspect "${CANARY_DIR}/data.db" >/dev/null
fi

clawmaster_log "启动 127.0.0.1:17777 隔离 canary"
"$NODE_PATH" "${TARGET_RELEASE}/run.mjs" >"${TXN_DIR}/canary.log" 2>&1 &
CANARY_PID=$!
canary_cleanup() {
  if kill -0 "$CANARY_PID" >/dev/null 2>&1; then
    kill -TERM "$CANARY_PID" >/dev/null 2>&1 || true
    wait "$CANARY_PID" || true
  fi
  CANARY_PID=""
}
CANARY_OK=0
for _ in $(seq 1 20); do
  if "$NODE_PATH" "${SCRIPT_DIR}/tools/health-check.mjs" \
    http://127.0.0.1:17777 "$RELEASE_VERSION" "$BUILD_ID" \
    "$RELEASE_SCHEMA_TO" \
    "$([ "$CLAWMASTER_ALLOW_SMS_DISABLED" = "1" ] && printf 'allow-sms-disabled' || printf 'require-sms')" \
    >/dev/null 2>&1; then
    CANARY_OK=1
    break
  fi
  sleep 0.5
done
[ "$CANARY_OK" -eq 1 ] || {
  sed -n '1,120p' "${TXN_DIR}/canary.log" >&2
  clawmaster_die "隔离 canary 未通过" 5
}
canary_cleanup

if ! id clawmaster-enterprise >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin \
    --user-group clawmaster-enterprise
fi
for key_path in \
  "$CLAWMASTER_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE" \
  "$CLAWMASTER_ATTACHMENT_ENCRYPTION_KEY_FILE" \
  "$CLAWMASTER_FIELD_ENCRYPTION_KEY_FILE"; do
  [ -z "$key_path" ] && continue
  runuser -u clawmaster-enterprise -- test -r "$key_path" \
    || clawmaster_die "clawmaster-enterprise 服务账号无法读取外部加密密钥：${key_path}"
done
mkdir -p "$DATA_DIR" "$CONFIG_DIR"
chown clawmaster-enterprise:clawmaster-enterprise "$DATA_DIR"
chmod 0700 "$DATA_DIR"
if [ -n "$CLAWMASTER_BACKUP_REPLICA_DIR" ]; then
  mkdir -p "$CLAWMASTER_BACKUP_REPLICA_DIR"
  chown clawmaster-enterprise:clawmaster-enterprise "$CLAWMASTER_BACKUP_REPLICA_DIR"
  chmod 0700 "$CLAWMASTER_BACKUP_REPLICA_DIR"
fi
install -o clawmaster-enterprise -g clawmaster-enterprise -m 0600 \
  "${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"
DATA_CREATED=1

write_env() {
  local output="$1"
  : > "$output"
  chmod 600 "$output"
  while [ "$#" -gt 1 ]; do
    local key="$2"
    local value="$3"
    shift 2
    [[ "$value" != *$'\n'* ]] || clawmaster_die "环境变量 ${key} 不能包含换行"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '%s="%s"\n' "$key" "$value" >> "$output"
  done
}

ENV_TEMP="${TXN_DIR}/enterprise.env"
write_env "$ENV_TEMP" \
  CLAWMASTER_ENTERPRISE_DIR "$DATA_DIR" \
  CLAWMASTER_ENTERPRISE_HOST "127.0.0.1" \
  CLAWMASTER_ENTERPRISE_PORT "7778" \
  CLAWMASTER_ENTERPRISE_PUBLIC_URL "$CLAWMASTER_ENTERPRISE_PUBLIC_URL" \
  CLAWMASTER_ENTERPRISE_ADMIN_TOKEN "$CLAWMASTER_ENTERPRISE_ADMIN_TOKEN" \
  CLAWMASTER_ENTERPRISE_TRUST_PROXY_HOPS "1" \
  CLAWMASTER_APP_VERSION "$RELEASE_VERSION" \
  CLAWMASTER_BUILD_COMMIT "$BUILD_ID" \
  CLAWMASTER_BACKUP_ENCRYPTION_KEY "$CLAWMASTER_BACKUP_ENCRYPTION_KEY" \
  CLAWMASTER_BACKUP_INTERVAL_HOURS "$CLAWMASTER_BACKUP_INTERVAL_HOURS" \
  CLAWMASTER_BACKUP_RETENTION_DAYS "$CLAWMASTER_BACKUP_RETENTION_DAYS" \
  CLAWMASTER_BACKUP_MINIMUM_RETAINED "$CLAWMASTER_BACKUP_MINIMUM_RETAINED" \
  CLAWMASTER_BACKUP_REPLICA_DIR "$CLAWMASTER_BACKUP_REPLICA_DIR" \
  CLAWMASTER_DISK_MIN_FREE_MB "$CLAWMASTER_DISK_MIN_FREE_MB" \
  CLAWMASTER_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE "$CLAWMASTER_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE" \
  CLAWMASTER_ATTACHMENT_ENCRYPTION_KEY_FILE "$CLAWMASTER_ATTACHMENT_ENCRYPTION_KEY_FILE" \
  CLAWMASTER_FIELD_ENCRYPTION_KEY_FILE "$CLAWMASTER_FIELD_ENCRYPTION_KEY_FILE" \
  CLAWMASTER_TELEMETRY_ENDPOINT "$CLAWMASTER_TELEMETRY_ENDPOINT" \
  CLAWMASTER_TELEMETRY_RETENTION_DAYS "$CLAWMASTER_TELEMETRY_RETENTION_DAYS" \
  CLAWMASTER_FEDERATION_ENABLED "$CLAWMASTER_FEDERATION_ENABLED" \
  CLAWMASTER_FEDERATION_GATEWAY_URL "$CLAWMASTER_FEDERATION_GATEWAY_URL" \
  CLAWMASTER_FEDERATION_DISPLAY_NAME "$CLAWMASTER_FEDERATION_DISPLAY_NAME" \
  CLAWMASTER_FEDERATION_POLL_INTERVAL_MS "$CLAWMASTER_FEDERATION_POLL_INTERVAL_MS" \
  CLAWMASTER_FEDERATION_SIGNING_KEY_FILE "$CLAWMASTER_FEDERATION_SIGNING_KEY_FILE" \
  CLAWMASTER_DATA_CONTROLLER_NAME "$CLAWMASTER_DATA_CONTROLLER_NAME" \
  CLAWMASTER_PRIVACY_CONTACT "$CLAWMASTER_PRIVACY_CONTACT" \
  CLAWMASTER_LEGAL_DOCUMENTS_APPROVED "$CLAWMASTER_LEGAL_DOCUMENTS_APPROVED" \
  CLAWMASTER_DATA_REGION "$CLAWMASTER_DATA_REGION" \
  CLAWMASTER_DATA_RESIDENCY "$CLAWMASTER_DATA_RESIDENCY" \
  CLAWMASTER_STORAGE_VOLUME_ENCRYPTED "$CLAWMASTER_STORAGE_VOLUME_ENCRYPTED" \
  CLAWMASTER_CROSS_BORDER_DATA_ENABLED "$CLAWMASTER_CROSS_BORDER_DATA_ENABLED" \
  ALIYUN_SMS_PROVIDER "${ALIYUN_SMS_PROVIDER:-pnvs}" \
  ALIYUN_SMS_ACCESS_KEY_ID "${ALIYUN_SMS_ACCESS_KEY_ID:-}" \
  ALIYUN_SMS_ACCESS_KEY_SECRET "${ALIYUN_SMS_ACCESS_KEY_SECRET:-}" \
  ALIYUN_SMS_SIGN_NAME "${ALIYUN_SMS_SIGN_NAME:-}" \
  ALIYUN_SMS_TEMPLATE_ID "${ALIYUN_SMS_TEMPLATE_ID:-}" \
  ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID "${ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID:-}" \
  CLAWMASTER_ENTERPRISE_FEISHU_APP_ID "${CLAWMASTER_ENTERPRISE_FEISHU_APP_ID:-}" \
  CLAWMASTER_ENTERPRISE_FEISHU_APP_SECRET "${CLAWMASTER_ENTERPRISE_FEISHU_APP_SECRET:-}" \
  CLAWMASTER_ENTERPRISE_FEISHU_DOMAIN "${CLAWMASTER_ENTERPRISE_FEISHU_DOMAIN:-}" \
  CLAWMASTER_DEFAULT_ORGANIZATION_NAME "${CLAWMASTER_DEFAULT_ORGANIZATION_NAME:-ClawMaster 企业}" \
  CLAWMASTER_ENTERPRISE_USAGE_DAILY_LIMIT "${CLAWMASTER_ENTERPRISE_USAGE_DAILY_LIMIT:-10000}" \
  CLAWMASTER_CREDIT_TOKEN_RATE "${CLAWMASTER_CREDIT_TOKEN_RATE:-1000000}" \
  CLAWMASTER_ESTIMATE_MANUAL_MULT "${CLAWMASTER_ESTIMATE_MANUAL_MULT:-2}" \
  CLAWMASTER_ESTIMATE_CNY_PER_HOUR "${CLAWMASTER_ESTIMATE_CNY_PER_HOUR:-50}" \
  CLAWMASTER_ESTIMATE_LABOR_PER_TOKEN_CAP "${CLAWMASTER_ESTIMATE_LABOR_PER_TOKEN_CAP:-50}"
install -o root -g root -m 0600 "$ENV_TEMP" "${CONFIG_DIR}/enterprise.env"
CONFIG_CREATED=1

[ ! -e "${INSTALL_ROOT}/current.next" ] && [ ! -L "${INSTALL_ROOT}/current.next" ] \
  || clawmaster_die "临时 current.next 路径已存在，拒绝覆盖" 3
ln -s "$TARGET_RELEASE" "${INSTALL_ROOT}/current.next"
mv -T "${INSTALL_ROOT}/current.next" "${INSTALL_ROOT}/current"
CURRENT_CREATED=1
install -o root -g root -m 0644 \
  "${SCRIPT_DIR}/templates/clawmaster-enterprise.service" "$SERVICE_UNIT"
CREATED_SERVICE=1
systemctl daemon-reload

if [ "$CLAWMASTER_CADDY_MODE" = "managed" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    clawmaster_log "安装 Caddy 官方 Ubuntu 软件包"
    apt-get update
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf --max-time 60 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf --max-time 60 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      -o /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    chmod o+r /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
  fi
  mkdir -p /etc/caddy
  if [ -f "$CADDY_MAIN" ]; then
    CADDY_MAIN_BACKUP="${TXN_DIR}/Caddyfile.before"
    cp -p "$CADDY_MAIN" "$CADDY_MAIN_BACKUP"
  else
    : > "$CADDY_MAIN"
  fi
  if [ -f "$CADDY_FRAGMENT" ]; then
    CADDY_FRAGMENT_BACKUP="${TXN_DIR}/clawmaster-enterprise.caddy.before"
    cp -p "$CADDY_FRAGMENT" "$CADDY_FRAGMENT_BACKUP"
  else
    : > "${TXN_DIR}/created-caddy-fragment"
  fi
  if grep -Fq "${CLAWMASTER_PUBLIC_HOST}:${CLAWMASTER_PUBLIC_PORT}" "$CADDY_MAIN"; then
    clawmaster_die "主 Caddyfile 已包含同一站点，拒绝制造重复路由" 3
  fi
  sed \
    -e "s/__CLAWMASTER_PUBLIC_HOST__/${CLAWMASTER_PUBLIC_HOST}/g" \
    -e "s/__CLAWMASTER_PUBLIC_PORT__/${CLAWMASTER_PUBLIC_PORT}/g" \
    "${SCRIPT_DIR}/templates/clawmaster-enterprise.caddy" > "${TXN_DIR}/clawmaster-enterprise.caddy"
  install -o root -g caddy -m 0644 \
    "${TXN_DIR}/clawmaster-enterprise.caddy" "$CADDY_FRAGMENT"
  if ! grep -Fxq "import ${CADDY_FRAGMENT}" "$CADDY_MAIN"; then
    printf '\n# ClawMaster Enterprise managed import\nimport %s\n' "$CADDY_FRAGMENT" >> "$CADDY_MAIN"
  fi
  caddy validate --config "$CADDY_MAIN" --adapter caddyfile
fi

systemctl enable --now clawmaster-enterprise
CLAWMASTER_ALLOW_SMS_DISABLED="$CLAWMASTER_ALLOW_SMS_DISABLED" "${INSTALL_ROOT}/deploy/verify.sh"

if [ "$CLAWMASTER_CADDY_MODE" = "managed" ]; then
  systemctl reload caddy
  EDGE_OK=0
  for _ in $(seq 1 30); do
    if "$NODE_PATH" "${SCRIPT_DIR}/tools/health-check.mjs" \
      "$CLAWMASTER_ENTERPRISE_PUBLIC_URL" "$RELEASE_VERSION" "$BUILD_ID" \
      "$RELEASE_SCHEMA_TO" \
      "$([ "$CLAWMASTER_ALLOW_SMS_DISABLED" = "1" ] && printf 'allow-sms-disabled' || printf 'require-sms')" \
      >/dev/null 2>&1; then
      EDGE_OK=1
      break
    fi
    sleep 2
  done
  [ "$EDGE_OK" -eq 1 ] \
    || clawmaster_die "公网 HTTPS 验收失败；请检查 DNS、80/443/7777 安全组和 Caddy 日志" 5
  for blocked in \
    /enterprise/local-agent \
    /enterprise/local-agent/pair \
    /enterprise/sdk/clawmaster-discovery.js; do
    STATUS="$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
      "${CLAWMASTER_ENTERPRISE_PUBLIC_URL}${blocked}")"
    [ "$STATUS" = "404" ] \
      || clawmaster_die "未完成功能没有在公网屏蔽：${blocked} -> HTTP ${STATUS}" 5
  done
fi

if [ -f "${TXN_DIR}/bootstrap-credentials.txt" ]; then
  install -o root -g root -m 0600 \
    "${TXN_DIR}/bootstrap-credentials.txt" \
    "/root/clawmaster-enterprise-bootstrap-${TRANSACTION_ID}.txt"
  BOOTSTRAP_CREDENTIALS_FINAL="/root/clawmaster-enterprise-bootstrap-${TRANSACTION_ID}.txt"
else
  BOOTSTRAP_CREDENTIALS_FINAL=""
fi

rm -f "$TRANSACTION_MARKER"
TRANSACTION_MARKER_CREATED=0
INSTALL_COMMITTED=1
if [ "$CLAWMASTER_CADDY_MODE" = "managed" ]; then
  clawmaster_log "安装、迁移、本机服务与公网 HTTPS 验收全部通过"
else
  clawmaster_log "安装、迁移与本机 systemd/health 验收通过"
  clawmaster_warn "external 模式未验证外置 HTTPS、证书或三个公网 404 屏蔽路径；当前结果不代表公网交付完成"
fi
printf '  版本：%s\n  构建 ID：%s\n  本机后端：http://127.0.0.1:7778\n' \
  "$RELEASE_VERSION" "$BUILD_ID"
if [ "$CLAWMASTER_CADDY_MODE" = "managed" ]; then
  printf '  已验收公网入口：%s\n' "$CLAWMASTER_ENTERPRISE_PUBLIC_URL"
else
  printf '  待外置代理验收入口：%s\n' "$CLAWMASTER_ENTERPRISE_PUBLIC_URL"
fi
if [ -n "$BOOTSTRAP_CREDENTIALS_FINAL" ]; then
  printf '  首次管理员凭据：%s（登录后请立即删除）\n' "$BOOTSTRAP_CREDENTIALS_FINAL"
fi
printf '  下一步：确认云安全组开放 TCP 80、443、%s；然后用真实客户端完成邀请码注册与组织树验收。\n' \
  "$CLAWMASTER_PUBLIC_PORT"
