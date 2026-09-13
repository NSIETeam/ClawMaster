/** Older WebKit defers SDK startup work with timers and reports no available idle budget. */
if (typeof window.requestIdleCallback !== 'function') {
  window.requestIdleCallback = (callback, options) => {
    const queuedAt = performance.now();
    return window.setTimeout(() => callback({
      didTimeout: options?.timeout !== undefined && performance.now() - queuedAt >= options.timeout,
      timeRemaining: () => 0,
    }), 1);
  };
  window.cancelIdleCallback = handle => window.clearTimeout(handle);
}
