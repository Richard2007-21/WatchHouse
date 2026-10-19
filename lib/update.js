/*
 * WatchHouse – update check against GitHub releases and in-place update.
 *
 * check()   asks the GitHub API for the latest release (at most every 6 h,
 *           the answer is cached in the app data folder).
 * install() downloads WatchHouse.zip of that release, unpacks it and swaps
 *           CSXS, client, host and lib in the extension folder. Premiere Pro /
 *           After Effects load the new version after a restart.
 *
 * Plain Node.js (CEP runs Node 8 to 17): no fetch, no fs.rmSync/cpSync.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var https = require('https');
var childProcess = require('child_process');
var urlLib = require('url');

var IS_WIN = process.platform === 'win32';
var REPO = 'Richard2007-21/WatchHouse';
var API_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
var RELEASES_URL = 'https://github.com/' + REPO + '/releases/latest';
var DOWNLOAD_PREFIX = 'https://github.com/' + REPO + '/releases/download/';
var ASSET_NAME = 'WatchHouse.zip';
var CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
// What the installer copies, and so what an update replaces.
var ITEMS = ['CSXS', 'client', 'host', 'lib', 'LICENSE'];

// ---------------------------------------------------------------------------
// Versions

// "v1.4.0" -> { nums: [1, 4, 0], pre: '' }; "1.5.0-beta.1" -> pre 'beta.1'.
function parseVersion(v) {
  var m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: [+m[1], +(m[2] || 0), +(m[3] || 0)], pre: m[4] || '' };
}

// -1, 0 or 1. A version that cannot be parsed counts as the lowest.
function compareVersions(a, b) {
  var x = parseVersion(a);
  var y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (var i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;   // 1.4.0 is newer than 1.4.0-beta
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

// Version of the extension in a folder, from CSXS/manifest.xml.
function readVersion(extPath) {
  try {
    var xml = fs.readFileSync(path.join(extPath, 'CSXS', 'manifest.xml'), 'utf8');
    var m = /ExtensionBundleVersion="([^"]+)"/.exec(xml);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

// The parts of a GitHub release the panel needs.
function releaseInfo(json) {
  if (!json || json.draft || json.prerelease || !parseVersion(json.tag_name)) return null;
  var zip = null;
  (json.assets || []).forEach(function (a) {
    if (a && a.name === ASSET_NAME && typeof a.browser_download_url === 'string' &&
        a.browser_download_url.indexOf(DOWNLOAD_PREFIX) === 0) zip = a.browser_download_url;
  });
  return {
    version: String(json.tag_name).replace(/^v/, ''),
    tag: String(json.tag_name),
    url: typeof json.html_url === 'string' && json.html_url.indexOf('https://github.com/' + REPO + '/') === 0 ?
      json.html_url : RELEASES_URL,
    notes: releaseNotes(json.body),
    zipUrl: zip,
    publishedAt: json.published_at || null
  };
}

// Release notes as short plain text: without the install steps and the
// Markdown marks, at most 12 lines.
function releaseNotes(body) {
  var text = String(body || '').replace(/\r\n/g, '\n');
  text = text.split(/\n#{2,3} *(Install|Installieren)/i)[0];
  var lines = text.split('\n').map(function (l) {
    return l.replace(/\*\*|__|`/g, '').replace(/^#+\s*/, '').replace(/^\s*[-*]\s+/, '• ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  }).filter(function (l, i, all) { return l || (i > 0 && all[i - 1]); });
  // The first line repeats "WatchHouse 1.x.y" – the banner shows that already.
  if (lines.length && /^WatchHouse\s+v?\d/i.test(lines[0])) lines.shift();
  while (lines.length && !lines[0]) lines.shift();
  return lines.slice(0, 12).join('\n').trim();
}

// ---------------------------------------------------------------------------
// HTTP

// GET with redirects. Resolves { status, body } (body is a Buffer).
function httpGet(url, opts) {
  opts = opts || {};
  var left = opts.redirects === undefined ? 5 : opts.redirects;
  return new Promise(function (resolve, reject) {
    if (!/^https:\/\//i.test(url)) { reject(new Error('only https: ' + url)); return; }
    var req = https.get(url, {
      headers: Object.assign({ 'User-Agent': 'WatchHouse-Updater' }, opts.headers || {})
    }, function (res) {
      var loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        if (left <= 0) { reject(new Error('too many redirects')); return; }
        var next = typeof URL === 'function' ? new URL(loc, url).toString() : urlLib.resolve(url, loc);
        resolve(httpGet(next, Object.assign({}, opts, { redirects: left - 1 })));
        return;
      }
      var chunks = [];
      var size = 0;
      res.on('data', function (c) {
        size += c.length;
        if (opts.maxBytes && size > opts.maxBytes) { req.destroy(new Error('download too big')); return; }
        chunks.push(c);
        if (opts.onProgress) opts.onProgress(size, +res.headers['content-length'] || 0);
      });
      res.on('end', function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks) }); });
      res.on('error', reject);
    });
    req.setTimeout(opts.timeout || 20000, function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function fetchLatest(get) {
  return (get || httpGet)(API_URL, { headers: { Accept: 'application/vnd.github+json' } }).then(function (r) {
    if (r.status === 404) return null;   // no release yet
    if (r.status !== 200) throw new Error('GitHub HTTP ' + r.status);
    return releaseInfo(JSON.parse(r.body.toString('utf8')));
  });
}

// ---------------------------------------------------------------------------
// Check

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJSON(file, data) {
  try {
    mkdirp(path.dirname(file));
    var tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { /* the cache is optional */ }
}

/*
 * opts: { current, stateFile, force, now, get }
 * Resolves { current, latest, available, checkedAt, error }.
 * Never rejects: without network the last cached answer is used.
 */
function check(opts) {
  var now = opts.now || Date.now();
  var state = (opts.stateFile && readJSON(opts.stateFile)) || {};
  var fresh = state.checkedAt && now - state.checkedAt < CHECK_EVERY_MS && now >= state.checkedAt;
  var result = function (latest, checkedAt, error) {
    return {
      current: opts.current,
      latest: latest || null,
      available: !!(latest && compareVersions(latest.version, opts.current) > 0),
      checkedAt: checkedAt || null,
      error: error || null
    };
  };
  if (fresh && !opts.force) return Promise.resolve(result(state.latest, state.checkedAt));
  return fetchLatest(opts.get).then(function (latest) {
    if (opts.stateFile) writeJSON(opts.stateFile, { checkedAt: now, latest: latest });
    return result(latest, now);
  }, function (err) {
    return result(state.latest, state.checkedAt, String(err && err.message || err));
  });
}

// ---------------------------------------------------------------------------
// Install

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

function rmrf(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (n) { rmrf(path.join(p, n)); });
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

function copyRec(src, dst) {
  var st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return;   // a release never needs links
  if (st.isDirectory()) {
    mkdirp(dst);
    fs.readdirSync(src).forEach(function (n) {
      if (n === '.DS_Store') return;
      copyRec(path.join(src, n), path.join(dst, n));
    });
  } else {
    fs.writeFileSync(dst, fs.readFileSync(src));
  }
}

/*
 * How this copy of the extension can be updated:
 *   'auto'   – installed by copying (installer or ZIP): update in place
 *   'dev'    – a git checkout or a symlink to one: update with git, never overwrite
 *   'manual' – the folder is not writable (e.g. installed for all users)
 */
function installMode(extPath) {
  try {
    if (fs.lstatSync(extPath).isSymbolicLink()) return 'dev';
    if (fs.existsSync(path.join(extPath, '.git'))) return 'dev';
    fs.accessSync(extPath, fs.constants ? fs.constants.W_OK : 2);
    for (var i = 0; i < ITEMS.length; i++) {
      var p = path.join(extPath, ITEMS[i]);
      if (fs.existsSync(p)) fs.accessSync(p, fs.constants ? fs.constants.W_OK : 2);
    }
    return 'auto';
  } catch (e) {
    return 'manual';
  }
}

function unzip(zipFile, destDir) {
  return new Promise(function (resolve, reject) {
    var cmd, args;
    if (IS_WIN) {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        'Expand-Archive -LiteralPath $env:WH_ZIP -DestinationPath $env:WH_DEST -Force'];
    } else {
      cmd = '/usr/bin/ditto';
      args = ['-x', '-k', zipFile, destDir];
    }
    var env = Object.assign({}, process.env, { WH_ZIP: zipFile, WH_DEST: destDir });
    childProcess.execFile(cmd, args, { env: env, timeout: 120000, windowsHide: true }, function (err, out, errOut) {
      if (err) reject(new Error('unzip failed: ' + (String(errOut || '').trim() || err.message)));
      else resolve();
    });
  });
}

// Finds the unpacked extension: the folder with CSXS/manifest.xml (normally "WatchHouse").
function findPackageRoot(dir) {
  if (fs.existsSync(path.join(dir, 'CSXS', 'manifest.xml'))) return dir;
  var kids = fs.readdirSync(dir).filter(function (n) {
    return n !== '__MACOSX' && fs.statSync(path.join(dir, n)).isDirectory();
  });
  for (var i = 0; i < kids.length; i++) {
    if (fs.existsSync(path.join(dir, kids[i], 'CSXS', 'manifest.xml'))) return path.join(dir, kids[i]);
  }
  return null;
}

// Swaps ITEMS of extPath for the ones in srcRoot. Stages copies inside
// extPath first, so the swap is a rename on the same disk; on any error the
// old files are put back.
function swapItems(srcRoot, extPath) {
  var stage = path.join(extPath, '.update-new');
  var backup = path.join(extPath, '.update-old');
  rmrf(stage);
  rmrf(backup);
  mkdirp(stage);
  mkdirp(backup);
  var moved = [];   // items moved to backup
  var placed = [];  // new items in place
  try {
    ITEMS.forEach(function (item) {
      if (fs.existsSync(path.join(srcRoot, item))) copyRec(path.join(srcRoot, item), path.join(stage, item));
    });
    if (!fs.existsSync(path.join(stage, 'CSXS', 'manifest.xml'))) throw new Error('package has no CSXS/manifest.xml');
    ITEMS.forEach(function (item) {
      var cur = path.join(extPath, item);
      var neu = path.join(stage, item);
      if (fs.existsSync(cur)) { fs.renameSync(cur, path.join(backup, item)); moved.push(item); }
      if (fs.existsSync(neu)) { fs.renameSync(neu, cur); placed.push(item); }
    });
  } catch (err) {
    placed.forEach(function (item) { try { rmrf(path.join(extPath, item)); } catch (e) {} });
    moved.forEach(function (item) {
      try { fs.renameSync(path.join(backup, item), path.join(extPath, item)); } catch (e) {}
    });
    try { rmrf(stage); } catch (e) {}
    try { rmrf(backup); } catch (e) {}
    throw err;
  }
  try { rmrf(stage); } catch (e) {}
  try { rmrf(backup); } catch (e) {}
}

/*
 * opts: { release, extPath, current, get, onStep(step), zipFile }
 * Steps: 'download', 'unpack', 'install'. Resolves the installed version.
 * zipFile skips the download (tests).
 */
function install(opts) {
  var release = opts.release;
  var extPath = opts.extPath;
  var step = opts.onStep || function () {};
  var mode = installMode(extPath);
  if (mode !== 'auto') return Promise.reject(new Error('install mode ' + mode));
  if (!opts.zipFile && (!release || !release.zipUrl)) return Promise.reject(new Error('release has no ' + ASSET_NAME));
  if (!opts.zipFile && release.zipUrl.indexOf(DOWNLOAD_PREFIX) !== 0) return Promise.reject(new Error('unexpected download URL'));

  var tmp = path.join(os.tmpdir(), 'watchhouse-update-' + process.pid + '-' + Date.now());
  var zip = opts.zipFile || path.join(tmp, ASSET_NAME);
  var out = path.join(tmp, 'unpacked');
  mkdirp(out);
  var cleanup = function () { try { rmrf(tmp); } catch (e) {} };

  var chain = Promise.resolve();
  if (!opts.zipFile) {
    chain = chain.then(function () {
      step('download');
      return (opts.get || httpGet)(release.zipUrl, { timeout: 60000, maxBytes: 200 * 1024 * 1024 });
    }).then(function (r) {
      if (r.status !== 200) throw new Error('download HTTP ' + r.status);
      if (r.body.length < 4 || r.body.readUInt32LE(0) !== 0x04034b50) throw new Error('download is not a ZIP file');
      fs.writeFileSync(zip, r.body);
    });
  }
  return chain.then(function () {
    step('unpack');
    return unzip(zip, out);
  }).then(function () {
    var root = findPackageRoot(out);
    if (!root) throw new Error('no WatchHouse extension in the ZIP file');
    var version = readVersion(root);
    if (!parseVersion(version)) throw new Error('no version in the new manifest');
    if (release && compareVersions(version, release.version) !== 0) {
      throw new Error('ZIP has version ' + version + ', release is ' + release.version);
    }
    if (opts.current && compareVersions(version, opts.current) < 0) {
      throw new Error('ZIP version ' + version + ' is older than ' + opts.current);
    }
    step('install');
    swapItems(root, extPath);
    cleanup();
    return version;
  }).catch(function (err) {
    cleanup();
    throw err;
  });
}

module.exports = {
  REPO: REPO, API_URL: API_URL, RELEASES_URL: RELEASES_URL, ASSET_NAME: ASSET_NAME,
  CHECK_EVERY_MS: CHECK_EVERY_MS, ITEMS: ITEMS,
  parseVersion: parseVersion, compareVersions: compareVersions, readVersion: readVersion,
  releaseInfo: releaseInfo, releaseNotes: releaseNotes, httpGet: httpGet, fetchLatest: fetchLatest,
  check: check, installMode: installMode, install: install, swapItems: swapItems,
  findPackageRoot: findPackageRoot
};
