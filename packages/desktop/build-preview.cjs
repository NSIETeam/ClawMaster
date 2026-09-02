// 浏览器预览构建：esbuild 打包 renderer → dist-preview/（不进 git，仅本地预览用）
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const root = __dirname;
const outdir = path.join(root, 'dist-preview');
const rendererStyles = [
  'src/renderer/styles/tokens.css',
  'src/renderer/styles/app.css',
  'src/renderer/styles/module-workspace.css',
];

esbuild.build({
  entryPoints: [path.join(root, 'src/renderer/index.tsx')],
  bundle: true,
  outfile: path.join(outdir, 'main.js'),
  assetNames: 'assets/[name]-[hash]',
  publicPath: './',
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome120',
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': '"development"',
    __CLAWMASTER_BROWSER_PREVIEW__: 'true',
  },
  // Match the production webpack aliases. Some workspace dependencies resolve
  // React from the monorepo root; without these aliases the preview ships two
  // hook dispatchers and crashes as soon as ModuleWorkspace mounts.
  alias: {
    react: path.dirname(require.resolve('react/package.json', { paths: [root] })),
    'react-dom': path.dirname(require.resolve('react-dom/package.json', { paths: [root] })),
  },
  loader: {
    '.png': 'file',
    '.svg': 'file',
    '.jpg': 'file',
    '.jpeg': 'file',
    '.gif': 'file',
  },
  logLevel: 'info',
}).then(() => {
  // Keep the browser preview on the exact same CSS baseline as the packaged
  // renderer. Previously index.html referenced main.css without producing it,
  // which made every control fall back to the browser's default appearance.
  const css = rendererStyles
    .map((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8'))
    .join('\n');
  fs.writeFileSync(path.join(outdir, 'main.css'), css);

  // 生成预览 HTML：基于 src/renderer/index.html，注入 bundle 引用
  const template = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const html = template.replace(
    '</body>',
    `  <link rel="stylesheet" href="./main.css?v=${Date.now()}" />\n  <script src="./main.js?v=${Date.now()}"></script>\n  </body>`,
  );
  fs.writeFileSync(path.join(outdir, 'index.html'), html);
  console.log('PREVIEW_READY ' + outdir);
}).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
