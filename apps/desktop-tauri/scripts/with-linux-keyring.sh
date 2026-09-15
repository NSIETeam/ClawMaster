#!/usr/bin/env bash
# Run a CI command with an isolated Secret Service inside a new dbus-run-session.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${RUNNER_OS:-}" != Linux || "${RUNNER_TEMP:-}" != /* || -z "${DBUS_SESSION_BUS_ADDRESS:-}" || $# -eq 0 ]]; then
  echo 'Secret Service acceptance requires a hosted Linux runner, a private D-Bus session and an explicit command.' >&2
  exit 1
fi
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Secret Service acceptance requires a Linux operating system.' >&2
  exit 1
fi

umask 077
task_keyring_root=$(mktemp -d "$RUNNER_TEMP/clawmaster-keyring-XXXXXX")
chmod 700 "$task_keyring_root"
export XDG_DATA_HOME="$task_keyring_root/data"
export XDG_CONFIG_HOME="$task_keyring_root/config"
export XDG_RUNTIME_DIR="$task_keyring_root/run"
mkdir -m 700 "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR" "$task_keyring_root/control"
unset GNOME_KEYRING_CONTROL GNOME_KEYRING_PID
task_keyring_pid=''
task_command_pid=''
task_child_pending() {
  local task_pid task_observed task_parent task_state
  for task_pid in $(jobs -p); do
    if [[ "$task_pid" == "$1" ]]; then
      task_observed=$(ps -p "$task_pid" -o ppid= -o stat= 2>/dev/null) || return 1
      read -r task_parent task_state <<< "$task_observed"
      # Bash 5 can make a bare return inherit the EXIT trap's triggering status.
      if [[ "$task_parent" == "$$" && "$task_state" != Z* ]]; then return 0; fi
      return 1
    fi
  done
  return 1
}
task_stop_child() {
  local task_pid=$1 task_deadline
  [[ -n "$task_pid" ]] || return 0
  if task_child_pending "$task_pid"; then
    kill -TERM "$task_pid" 2>/dev/null || true
    task_deadline=$((SECONDS + 10))
    while ((SECONDS < task_deadline)); do
      task_child_pending "$task_pid" || break
      sleep 0.1
    done
    if task_child_pending "$task_pid"; then
      kill -KILL "$task_pid" 2>/dev/null || true
      task_deadline=$((SECONDS + 2))
      while ((SECONDS < task_deadline)); do
        task_child_pending "$task_pid" || break
        sleep 0.1
      done
    fi
  fi
  if task_child_pending "$task_pid"; then
    echo 'Owned acceptance child did not exit; retaining its private files.' >&2
    return 1
  fi
  # Bash has reaped this direct child; wait only collects its already available status.
  wait "$task_pid" 2>/dev/null || true
}
task_keyring_cleanup() {
  local task_status=$? task_cleanup_failed=0
  trap - EXIT INT TERM
  task_stop_child "$task_command_pid" || task_cleanup_failed=1
  task_stop_child "$task_keyring_pid" || task_cleanup_failed=1
  if [[ "$task_status" -eq 0 && "$task_cleanup_failed" -eq 0 ]]; then
    rm -rf -- "$task_keyring_root"
  else
    echo "Secret Service acceptance files retained at: $task_keyring_root" >&2
    if [[ "$task_status" -eq 0 ]]; then task_status=1; fi
  fi
  exit "$task_status"
}
trap task_keyring_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# This password protects disposable synthetic test keys only.
gnome-keyring-daemon --foreground --unlock --components=secrets --control-directory "$task_keyring_root/control" <<< 'clawmaster-disposable-ci-keyring' >"$task_keyring_root/daemon.log" 2>&1 &
task_keyring_pid=$!
gdbus wait --session --timeout 30 org.freedesktop.secrets
kill -0 "$task_keyring_pid"
task_service_owner=$(gdbus call --session --timeout 10 --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetConnectionUnixProcessID org.freedesktop.secrets)
if [[ "$task_service_owner" != "(uint32 $task_keyring_pid,)" ]]; then
  echo 'Secret Service is not owned by this acceptance command.' >&2
  exit 1
fi
"$@" <&0 &
task_command_pid=$!
wait "$task_command_pid"
