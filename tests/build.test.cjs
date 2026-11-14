const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('build creates one userscript with metadata and valid JavaScript', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.cjs')], {
    cwd: root,
    stdio: 'pipe',
  });
  const output = fs.readFileSync(
    path.join(root, 'dist', 'chaoxing-deepseek.user.js'),
    'utf8',
  );
  assert.match(output, /==UserScript==/);
  assert.match(
    output,
    /@match\s+https:\/\/mooc2-ans\.chaoxing\.com/,
  );
  assert.match(output, /@connect\s+chat\.deepseek\.com/);
  assert.match(output, /@connect\s+fe-static\.deepseek\.com/);
  assert.match(output, /bootstrapAuthPage/);
  assert.doesNotMatch(output, /^\s*require\(/m);
  const body = output.replace(
    /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/,
    '',
  );
  assert.doesNotThrow(() => new Function(body));
});
