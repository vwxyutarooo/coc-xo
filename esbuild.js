/* eslint-disable @typescript-eslint/no-var-requires */
async function start(watch) {
  await require('esbuild').build({
    entryPoints: ['src/index.ts'],
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development') },
    bundle: true,
    watch,
    minify: process.env.NODE_ENV === 'production',
    sourcemap: process.env.NODE_ENV === 'development',
    mainFields: ['module', 'main'],
    external: ['coc.nvim'],
    platform: 'node',
    target: 'node12.16',
    outdir: 'lib',
  });
}

let watch = false;
if (process.argv.length > 2 && process.argv[2] === '--watch') {
  console.log('watching...');
  watch = {
    onRebuild(error) {
      if (error) {
        console.error('watch build failed:', error);
      } else {
        console.log('watch build succeeded');
      }
    },
  };
}

start(watch).catch((e) => {
  console.error(e);
});
