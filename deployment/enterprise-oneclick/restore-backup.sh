#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

ARCHIVE="${1:-}"
CONFIG_PATH="${2:-/etc/clawmaster-enterprise/enterprise.env}"
[ "$(id -u)" -eq 0 ] || clawmaster_die "恢复备份必须使用 sudo/root" 3
[ -n "$ARCHIVE" ] || clawmaster_die "用法：sudo ./restore-backup.sh /绝对路径/备份.clawmaster-backup [enterprise.env]"
case "$ARCHIVE" in /*) ;; *) clawmaster_die "备份路径必须是绝对路径" ;; esac
[ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || clawmaster_die "备份不存在或不安全" 3
[ -f "$CONFIG_PATH" ] && [ ! -L "$CONFIG_PATH" ] || clawmaster_die "运行配置不存在或不安全" 3

exec 9>/run/lock/clawmaster-enterprise-deploy.lock
flock -n 9 || clawmaster_die "已有部署、升级或恢复操作正在运行" 3
set -a
# shellcheck disable=SC1090
source "$CONFIG_PATH"
set +a

NODE="/opt/clawmaster-enterprise/runtime/current/bin/node"
CLI="/opt/clawmaster-enterprise/current/src/modules/data_platform/dataProtectionCli.js"
RELEASE_INFO="$("$NODE" "${SCRIPT_DIR}/tools/verify-release.mjs" /opt/clawmaster-enterprise/current)"
SCHEMA_TO="$("$NODE" -e "const x=JSON.parse(process.argv[1]);console.log(x.database.schemaTo)" "$RELEASE_INFO")"
DATA_DIR="${CLAWMASTER_ENTERPRISE_DIR:-/var/lib/clawmaster-enterprise}"
RECEIPT="$(mktemp /var/tmp/clawmaster-restore-receipt.XXXXXX.json)"
trap 'rm -f "$RECEIPT"' EXIT

clawmaster_log "先执行解密、认证和 SQLite 恢复演练"
"$NODE" "$CLI" verify --archive "$ARCHIVE" --data-dir "$DATA_DIR" --max-schema "$SCHEMA_TO" >/dev/null

systemctl stop clawmaster-enterprise
if ! "$NODE" "$CLI" restore --archive "$ARCHIVE" --data-dir "$DATA_DIR" \
  --max-schema "$SCHEMA_TO" --receipt "$RECEIPT"; then
  systemctl start clawmaster-enterprise || true
  clawmaster_die "恢复未写入完成，原服务已重新启动" 5
fi
chown -R clawmaster-enterprise:clawmaster-enterprise "$DATA_DIR"
chmod 0700 "$DATA_DIR"
systemctl start clawmaster-enterprise

HEALTHY=0
for _ in $(seq 1 30); do
  if "${SCRIPT_DIR}/verify.sh" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 1
done
if [ "$HEALTHY" -ne 1 ]; then
  clawmaster_warn "恢复后的服务未通过健康检查，自动回滚到恢复前数据"
  systemctl stop clawmaster-enterprise || true
  ROLLBACK_DIR="$("$NODE" -e "const x=require('fs').readFileSync(process.argv[1],'utf8');console.log(JSON.parse(x).rollbackDirectory)" "$RECEIPT")"
  "$NODE" "$CLI" rollback --data-dir "$DATA_DIR" --rollback-dir "$ROLLBACK_DIR"
  chown -R clawmaster-enterprise:clawmaster-enterprise "$DATA_DIR"
  systemctl start clawmaster-enterprise
  "${SCRIPT_DIR}/verify.sh" >/dev/null \
    || clawmaster_die "恢复失败且旧数据回滚后服务仍不健康，需要人工检查" 6
  clawmaster_die "恢复后的版本不健康，已自动回滚到原数据" 5
fi

clawmaster_log "备份恢复和服务健康检查均通过；恢复前数据仍保留在 receipt 指向的 rollbackDirectory"
