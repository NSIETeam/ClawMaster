/** esbuild loads stylesheets as text so a plugin can own its own scoped CSS. */
declare module '*.css' {
  const content: string;
  export default content;
}
