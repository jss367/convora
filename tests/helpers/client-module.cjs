const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

// Bundle a client module (JSX included) with its local imports and load it in
// this process, sharing the test's own npm packages, such as React.
function loadClientModule(relativePath) {
  const modulePath = path.join(__dirname, '../..', relativePath);
  const { outputFiles } = buildSync({
    entryPoints: [modulePath], bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  });
  const loaded = { exports: {} };
  const run = vm.runInThisContext(`(function(require, module, exports) { ${outputFiles[0].text}\n})`, { filename: modulePath });
  run(require, loaded, loaded.exports);
  return loaded.exports;
}

module.exports = { loadClientModule };
