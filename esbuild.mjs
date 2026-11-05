import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  logLevel: 'info',
  minify: false,
  sourcemap: false,
};

const configs = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'media/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'media/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
  {
    ...common,
    entryPoints: ['src/webview/style.css'],
    outfile: 'media/style.css',
    bundle: true,
  },
];

if (watch) {
  const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('watching…');
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
}
