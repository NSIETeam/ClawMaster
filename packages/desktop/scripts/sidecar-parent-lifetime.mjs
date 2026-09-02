import { readFileSync, unlinkSync } from 'node:fs';

export function removeOwnedEndpoint(endpointPath, pid = process.pid) {
  try {
    const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8'));
    if (endpoint.pid !== pid) return false;
    unlinkSync(endpointPath);
    return true;
  } catch {
    return false;
  }
}

export function isExpectedParentAlive(parentPid, {
  currentParentPid = process.ppid,
  probe = (pid) => process.kill(pid, 0),
} = {}) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || currentParentPid !== parentPid) return false;
  try {
    probe(parentPid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tie a packaged Agent sidecar to the desktop process without polling.
 *
 * The desktop owns the write end of a private stdin pipe. The operating system
 * closes that pipe even when the desktop crashes or is force-terminated, so an
 * EOF is a reliable signal that this sidecar must not remain resident.
 */
export function bindSidecarToParentPipe({
  input = process.stdin,
  exit = (code) => process.exit(code),
  beforeExit = () => {},
  parentPid,
  watchdogMs = 2_000,
} = {}) {
  let stopped = false;
  let watchdog = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (watchdog) clearTimeout(watchdog);
    try {
      beforeExit();
    } finally {
      exit(0);
    }
  };

  input.once('end', stop);
  input.once('close', stop);
  input.once('error', stop);
  input.resume();

  const checkParent = () => {
    if (stopped || !parentPid) return;
    if (!isExpectedParentAlive(parentPid)) {
      stop();
      return;
    }
    watchdog = setTimeout(checkParent, watchdogMs);
    watchdog.unref?.();
  };
  if (parentPid) checkParent();

  return () => {
    input.off('end', stop);
    input.off('close', stop);
    input.off('error', stop);
    input.pause();
    if (watchdog) clearTimeout(watchdog);
  };
}
