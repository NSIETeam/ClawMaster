/**
 * sherpa-onnx-node ships no type declarations (its `types` field is null and the published JSDoc
 * lives in types.js). This is the minimal declaration for the one thing this package imports: the
 * module resolves at all, so `loadEngine` can shape the objects it needs itself.
 */
declare module 'sherpa-onnx-node' {
  const value: unknown;
  export default value;
}
