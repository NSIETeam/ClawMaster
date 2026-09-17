/** Add the production Host event API when a test supplies only HTTP and tool fakes. */
export function watchdogTaskTestContext(context) {
  if (typeof context.on !== 'function') context.on = () => () => {};
  if (!context.logger) context.logger = { warn() {} };
  return context;
}
