'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const moduleNames = [
  'core',
  'auth',
  'deepseek',
  'chaoxing',
  'controller',
  'app',
];
const metadata = fs.readFileSync(
  path.join(root, 'src', 'metadata.txt'),
  'utf8',
).trim();

const definitions = moduleNames.map((name) => {
  const source = fs.readFileSync(
    path.join(root, 'src', `${name}.cjs`),
    'utf8',
  );
  return `define(${JSON.stringify(name)}, function(module, exports, require) {\n${source}\n});`;
}).join('\n\n');

const bundle = `${metadata}

(function() {
  'use strict';

  var factories = Object.create(null);
  var cache = Object.create(null);

  function normalize(name) {
    return String(name).replace(/^\\.\\//, '').replace(/\\.cjs$/, '');
  }

  function define(name, factory) {
    factories[name] = factory;
  }

  function localRequire(name) {
    var id = normalize(name);
    if (cache[id]) return cache[id].exports;
    if (!factories[id]) throw new Error('Unknown module: ' + id);
    var module = { exports: {} };
    cache[id] = module;
    factories[id](module, module.exports, localRequire);
    return module.exports;
  }

${definitions}

  var app = localRequire('app');
  if (location.hostname === 'chat.deepseek.com') {
    app.bootstrapAuthPage();
  } else {
    app.bootstrap();
  }
})();
`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'dist', 'chaoxing-deepseek.user.js'),
  bundle,
  'utf8',
);
console.log('Built dist/chaoxing-deepseek.user.js');
