// WatchHouse test: update check and in-place update (lib/update.js), without network.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const upd = require(path.join(__dirname, '..', 'lib', 'update.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watchhouse-update-test-'));
const DL = 'https://github.com/Richard2007-21/WatchHouse/releases/download/';

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ---------------- versions
test('compareVersions', () => {
  assert.strictEqual(upd.compareVersions('1.4.0', '1.3.0'), 1);
  assert.strictEqual(upd.compareVersions('v1.3.0', '1.3.0'), 0);
  assert.strictEqual(upd.compareVersions('1.3.0', '1.10.0'), -1);
  assert.strictEqual(upd.compareVersions('2.0', '1.9.9'), 1);
  assert.strictEqual(upd.compareVersions('1.4.0-beta', '1.4.0'), -1);
  assert.strictEqual(upd.compareVersions('1.4.0', '1.4.0-beta'), 1);
  assert.strictEqual(upd.compareVersions('garbage', '0.0.1'), -1);
});

// ---------------- release parsing
const BODY = '**WatchHouse 1.4.0**\n\n- Update banner\n- [Link](https://x)\n\n### Install / Installieren\n1. Download';
function release(tag, extra) {
  return Object.assign({
    tag_name: tag, html_url: 'https://github.com/Richard2007-21/WatchHouse/releases/tag/' + tag, body: BODY,
    assets: [{ name: 'WatchHouse.zip', browser_download_url: DL + tag + '/WatchHouse.zip' }]
  }, extra || {});
}

test('releaseInfo and notes', () => {
  const r = upd.releaseInfo(release('v1.4.0'));
  assert.strictEqual(r.version, '1.4.0');
  assert.strictEqual(r.zipUrl, DL + 'v1.4.0/WatchHouse.zip');
  assert.strictEqual(r.notes, '• Update banner\n• Link');
  assert.strictEqual(upd.releaseInfo(release('v1.4.0', { prerelease: true })), null);
  assert.strictEqual(upd.releaseInfo(release('v1.4.0', { draft: true })), null);
  // Only the project's own release downloads are accepted.
  const evil = upd.releaseInfo(release('v1.4.0', {
    assets: [{ name: 'WatchHouse.zip', browser_download_url: 'https://evil.example/WatchHouse.zip' }],
    html_url: 'https://evil.example/'
  }));
  assert.strictEqual(evil.zipUrl, null);
  assert.strictEqual(evil.url, upd.RELEASES_URL);
});

// ---------------- check with cache
function fakeGet(responses) {
  const calls = [];
  const get = (url) => {
    calls.push(url);
    const r = responses.shift();
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ status: r.status, body: Buffer.from(JSON.stringify(r.json || {})) });
  };
  get.calls = calls;
  return get;
}

test('check: new version, cache, force, offline', async () => {
  const stateFile = path.join(TMP, 'state', 'update-check.json');
  const t0 = 1700000000000;
  let get = fakeGet([{ status: 200, json: release('v1.4.0') }]);
  let r = await upd.check({ current: '1.3.0', stateFile, now: t0, get });
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.latest.version, '1.4.0');
  assert.strictEqual(get.calls[0], upd.API_URL);

  // Within 6 h: answer from the cache, no request.
  get = fakeGet([]);
  r = await upd.check({ current: '1.3.0', stateFile, now: t0 + 60000, get });
  assert.strictEqual(get.calls.length, 0);
  assert.strictEqual(r.available, true);

  // Same version installed: nothing to do.
  r = await upd.check({ current: '1.4.0', stateFile, now: t0 + 60000, get });
  assert.strictEqual(r.available, false);

  // force asks again; offline falls back to the cache and reports the error.
  get = fakeGet([new Error('ENOTFOUND')]);
  r = await upd.check({ current: '1.3.0', stateFile, now: t0 + 120000, get, force: true });
  assert.strictEqual(get.calls.length, 1);
  assert.strictEqual(r.available, true);
  assert.ok(/ENOTFOUND/.test(r.error));
  assert.strictEqual(r.checkedAt, t0);

  // After 6 h it asks again; a rate limit is an error, not a crash.
  get = fakeGet([{ status: 403, json: { message: 'rate limit' } }]);
  r = await upd.check({ current: '1.3.0', stateFile, now: t0 + upd.CHECK_EVERY_MS + 1, get });
  assert.strictEqual(get.calls.length, 1);
  assert.ok(/403/.test(r.error));

  // No release yet (404).
  get = fakeGet([{ status: 404 }]);
  r = await upd.check({ current: '1.3.0', stateFile: path.join(TMP, 'other.json'), now: t0, get });
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.latest, null);
  assert.strictEqual(r.error, null);

  // A clock set back does not freeze the cache.
  get = fakeGet([{ status: 200, json: release('v1.5.0') }]);
  r = await upd.check({ current: '1.3.0', stateFile, now: t0 - 1000, get });
  assert.strictEqual(get.calls.length, 1);
  assert.strictEqual(r.latest.version, '1.5.0');
});

// ---------------- install
function makePackage(dir, version, marker) {
  fs.mkdirSync(path.join(dir, 'CSXS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CSXS', 'manifest.xml'),
    '<ExtensionManifest ExtensionBundleId="com.watchhouse" ExtensionBundleVersion="' + version + '"/>');
  for (const d of ['client', 'host', 'lib']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, d, 'file.js'), marker + ' ' + d);
  }
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT ' + marker);
}

function zipPackage(version, marker) {
  const stage = path.join(TMP, 'pkg-' + version + '-' + marker);
  makePackage(path.join(stage, 'WatchHouse'), version, marker);
  fs.writeFileSync(path.join(stage, 'WatchHouse', 'README.md'), 'readme');
  const zip = stage + '.zip';
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(stage, 'WatchHouse'), zip]);
  return zip;
}

function makeExt(name, version) {
  const ext = path.join(TMP, name, 'WatchHouse');
  makePackage(ext, version, 'old');
  fs.writeFileSync(path.join(ext, 'client', 'only-old.js'), 'gone after update');
  return ext;
}

test('installMode', () => {
  const ext = makeExt('mode', '1.3.0');
  assert.strictEqual(upd.installMode(ext), 'auto');
  const link = path.join(TMP, 'mode', 'Linked');
  fs.symlinkSync(ext, link);
  assert.strictEqual(upd.installMode(link), 'dev');
  fs.mkdirSync(path.join(ext, '.git'));
  assert.strictEqual(upd.installMode(ext), 'dev');
  assert.strictEqual(upd.installMode(path.join(TMP, 'does-not-exist')), 'manual');
});

const canZip = process.platform === 'darwin';

test('install from ZIP replaces the extension files', async () => {
  if (!canZip) return 'skipped (needs ditto)';
  const ext = makeExt('inst', '1.3.0');
  const zip = zipPackage('1.4.0', 'new');
  const steps = [];
  const v = await upd.install({
    release: { version: '1.4.0', zipUrl: DL + 'v1.4.0/WatchHouse.zip' }, extPath: ext, current: '1.3.0',
    zipFile: zip, onStep: s => steps.push(s)
  });
  assert.strictEqual(v, '1.4.0');
  assert.deepStrictEqual(steps, ['unpack', 'install']);
  assert.strictEqual(upd.readVersion(ext), '1.4.0');
  assert.strictEqual(fs.readFileSync(path.join(ext, 'lib', 'file.js'), 'utf8'), 'new lib');
  assert.strictEqual(fs.readFileSync(path.join(ext, 'LICENSE'), 'utf8'), 'MIT new');
  assert.ok(!fs.existsSync(path.join(ext, 'client', 'only-old.js')), 'old client files removed');
  assert.ok(!fs.existsSync(path.join(ext, 'README.md')), 'only the installer items are copied');
  assert.ok(!fs.existsSync(path.join(ext, '.update-new')) && !fs.existsSync(path.join(ext, '.update-old')));
});

test('install refuses a wrong version and keeps the old files', async () => {
  if (!canZip) return 'skipped (needs ditto)';
  const ext = makeExt('wrong', '1.3.0');
  const zip = zipPackage('1.3.5', 'wrong');
  await assert.rejects(upd.install({
    release: { version: '1.4.0', zipUrl: DL + 'v1.4.0/WatchHouse.zip' }, extPath: ext, current: '1.3.0', zipFile: zip
  }), /version 1\.3\.5/);
  assert.strictEqual(upd.readVersion(ext), '1.3.0');
  assert.ok(fs.existsSync(path.join(ext, 'client', 'only-old.js')));
});

test('install refuses a developer checkout', async () => {
  const ext = makeExt('dev', '1.3.0');
  fs.mkdirSync(path.join(ext, '.git'));
  await assert.rejects(upd.install({ release: { version: '1.4.0', zipUrl: DL + 'x' }, extPath: ext }), /mode dev/);
  assert.strictEqual(fs.readFileSync(path.join(ext, 'lib', 'file.js'), 'utf8'), 'old lib');
});

test('install downloads through get and checks the file', async () => {
  if (!canZip) return 'skipped (needs ditto)';
  const ext = makeExt('dl', '1.3.0');
  const zip = fs.readFileSync(zipPackage('1.4.0', 'dl'));
  const urls = [];
  const get = (url) => { urls.push(url); return Promise.resolve({ status: 200, body: zip }); };
  const steps = [];
  const v = await upd.install({
    release: { version: '1.4.0', zipUrl: DL + 'v1.4.0/WatchHouse.zip' }, extPath: ext, current: '1.3.0',
    get, onStep: s => steps.push(s)
  });
  assert.strictEqual(v, '1.4.0');
  assert.deepStrictEqual(urls, [DL + 'v1.4.0/WatchHouse.zip']);
  assert.deepStrictEqual(steps, ['download', 'unpack', 'install']);

  // An HTML error page instead of the ZIP file is refused.
  const ext2 = makeExt('dl2', '1.3.0');
  const html = () => Promise.resolve({ status: 200, body: Buffer.from('<html>') });
  await assert.rejects(upd.install({
    release: { version: '1.4.0', zipUrl: DL + 'v1.4.0/WatchHouse.zip' }, extPath: ext2, get: html
  }), /not a ZIP/);
  // A download URL outside the project's releases is refused.
  await assert.rejects(upd.install({
    release: { version: '1.4.0', zipUrl: 'https://evil.example/WatchHouse.zip' }, extPath: ext2, get: html
  }), /unexpected download URL/);
  assert.strictEqual(upd.readVersion(ext2), '1.3.0');
});

test('swapItems rolls back when the new package is broken', () => {
  const ext = makeExt('roll', '1.3.0');
  const src = path.join(TMP, 'broken');
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(src, 'lib', 'file.js'), 'broken');
  assert.throws(() => upd.swapItems(src, ext), /manifest/);
  assert.strictEqual(fs.readFileSync(path.join(ext, 'lib', 'file.js'), 'utf8'), 'old lib');
  assert.strictEqual(upd.readVersion(ext), '1.3.0');
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      const note = await fn();
      console.log('ok   ' + name + (note ? ' – ' + note : ''));
    } catch (e) {
      failures++;
      console.log('FAIL ' + name + '\n     ' + (e && e.stack || e));
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? failures + ' update test(s) failed' : 'update tests passed');
  process.exit(failures ? 1 : 0);
})();
