/*
 * WatchHouse – core logic (Node.js, no CEP dependencies).
 * Config storage, folder scanning, camera card and image sequence detection,
 * and the import plan. Written in ES2017 so it also runs in old CEP runtimes.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');

var IS_WIN = process.platform === 'win32';
var CASE_INSENSITIVE = IS_WIN || process.platform === 'darwin';

var DEFAULT_EXTENSIONS = [
  // video
  'mov', 'mp4', 'm4v', 'mxf', 'avi', 'mkv', 'webm', 'mts', 'm2ts', 'm2t', 'mpg', 'mpeg', 'mpe', 'vob',
  'wmv', 'flv', '3gp', 'r3d', 'braw', 'ari', 'arx', 'crm', 'dv', 'hevc', 'ts', 'mod',
  // audio
  'wav', 'mp3', 'aif', 'aiff', 'aifc', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'bwf', 'caf', 'ac3',
  // images and graphics
  'png', 'jpg', 'jpeg', 'jfif', 'tif', 'tiff', 'psd', 'ai', 'eps', 'exr', 'dpx', 'tga', 'gif', 'bmp',
  'heic', 'heif', 'dng', 'cin', 'svg', 'webp'
];

// Extensions that can form an image sequence.
var IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'exr', 'dpx', 'tga', 'bmp', 'gif', 'psd',
  'dng', 'cin', 'ari', 'heic', 'webp'];

var DEFAULT_SETTINGS = {
  showImportOptions: false,
  addImportDate: false,
  notifications: true,
  allowedExtensions: DEFAULT_EXTENSIONS,
  ignoredFolders: ['proxies', 'untitled folder', 'Neuer Ordner', 'Unbenannter Ordner', 'New folder', '/^_AME$/'],
  stableMs: 1500,
  autoStartOnAdd: true,    // start auto-sync when a folder is added
  checkUpdates: true,      // look for a new release on GitHub
  psdImportAs: 'footage',  // After Effects: footage | comp | compCropped
  language: null           // 'de' | 'en'; null = language of the Adobe app
};

// Premiere label indexes 0-15 (order of the Premiere label menu).
var LABELS = [
  { name: 'Violett', en: 'Violet', color: '#a990dd' }, { name: 'Iris', en: 'Iris', color: '#8d9df0' },
  { name: 'Karibik', en: 'Caribbean', color: '#1cb5b5' }, { name: 'Lavendel', en: 'Lavender', color: '#e384e3' },
  { name: 'Coelinblau', en: 'Cerulean', color: '#1db8f0' }, { name: 'Waldgrün', en: 'Forest', color: '#52a33c' },
  { name: 'Rosa', en: 'Rose', color: '#f06aa6' }, { name: 'Mango', en: 'Mango', color: '#f29b2e' },
  { name: 'Lila', en: 'Purple', color: '#9c4ce0' }, { name: 'Blau', en: 'Blue', color: '#3c6cf0' },
  { name: 'Blaugrün', en: 'Teal', color: '#2fa69a' }, { name: 'Magenta', en: 'Magenta', color: '#e04fd5' },
  { name: 'Hautfarben', en: 'Tan', color: '#d6b490' }, { name: 'Grün', en: 'Green', color: '#3dbf6e' },
  { name: 'Braun', en: 'Brown', color: '#9c6b3c' }, { name: 'Gelb', en: 'Yellow', color: '#e3d23c' }
];

// After Effects labels 1-16, stored as index 0-15.
var AE_LABELS = [
  { name: 'Rot', en: 'Red', color: '#b53838' }, { name: 'Gelb', en: 'Yellow', color: '#e4d84c' },
  { name: 'Aquamarin', en: 'Aqua', color: '#a9cbc7' }, { name: 'Rosa', en: 'Pink', color: '#e5bcc9' },
  { name: 'Lavendel', en: 'Lavender', color: '#a9a9ca' }, { name: 'Pfirsich', en: 'Peach', color: '#e7c19e' },
  { name: 'Seegrün', en: 'Sea Foam', color: '#b3c7b3' }, { name: 'Blau', en: 'Blue', color: '#677de0' },
  { name: 'Grün', en: 'Green', color: '#4aa44c' }, { name: 'Lila', en: 'Purple', color: '#8e2c9a' },
  { name: 'Orange', en: 'Orange', color: '#e8920d' }, { name: 'Braun', en: 'Brown', color: '#7f452a' },
  { name: 'Fuchsia', en: 'Fuchsia', color: '#f46dd6' }, { name: 'Cyan', en: 'Cyan', color: '#3da2a5' },
  { name: 'Sandstein', en: 'Sandstone', color: '#a89677' }, { name: 'Dunkelgrün', en: 'Dark Green', color: '#1e401e' }
];

function labelsFor(host) { return host === 'AEFT' ? AE_LABELS : LABELS; }

// ---------------------------------------------------------------------------
// Paths

function normPath(p) {
  var n = path.resolve(String(p)).normalize('NFC');
  if (n.length > 1 && (n.charAt(n.length - 1) === '/' || n.charAt(n.length - 1) === '\\')) {
    n = n.slice(0, -1);
  }
  return n;
}

// Key used to compare paths of project items with paths on disk.
function pathKey(p) {
  var n = normPath(p);
  if (IS_WIN) n = n.replace(/\//g, '\\');
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

function isInside(child, parent) {
  var c = pathKey(child), p = pathKey(parent);
  return c !== p && c.indexOf(p + path.sep.toLowerCase()) === 0;
}

function toRelative(abs, projectDir) {
  return path.relative(projectDir, abs).split(path.sep).join('/');
}

function resolveRootPath(root, projectDir) {
  if (root.rel) {
    return path.resolve(projectDir, String(root.path).split('/').join(path.sep));
  }
  return String(root.path);
}

function extOf(name) {
  var i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function isHiddenName(name) {
  return name.charAt(0) === '.' || name.indexOf('~$') === 0 || name === 'Thumbs.db' || name === 'desktop.ini';
}

// ---------------------------------------------------------------------------
// Settings and project config

function appDataDir(name) {
  name = name || 'WatchHouse';
  if (IS_WIN) return path.join(process.env.APPDATA || os.homedir(), name);
  return path.join(os.homedir(), 'Library', 'Application Support', name);
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

// Reads a JSON file. A file that exists but cannot be parsed is kept as
// <file>.bak, so a later save never silently drops the user's settings.
function readJSON(file, fallback) {
  var text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return fallback; }
  try { return JSON.parse(text); } catch (e) {
    try { fs.writeFileSync(file + '.bak', text, 'utf8'); } catch (e2) { /* read-only */ }
    return fallback;
  }
}

function writeJSON(file, data) {
  mkdirp(path.dirname(file));
  var tmp = file + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 6) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function settingsFile() { return path.join(appDataDir(), 'settings.json'); }

function loadSettings() {
  // Before the rename the app was called Ordnerwache: take its settings over once.
  var s = readJSON(settingsFile(), null) || readJSON(path.join(appDataDir('Ordnerwache'), 'settings.json'), {});
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    out[k] = s[k] !== undefined ? s[k] : DEFAULT_SETTINGS[k];
  });
  return out;
}

function saveSettings(s) { writeJSON(settingsFile(), s); }

// The project config lives next to the project file, so it travels with
// project templates. Projects without a writable folder use the app data dir.
// The file name keeps the project extension (Edit.prproj.watchhouse.json),
// so a Premiere and an After Effects project with the same name do not share it.
function configFile(projectPath) {
  var dir = path.dirname(projectPath || '');
  var base = path.basename(projectPath || 'Unbenannt');
  if (projectPath && fs.existsSync(dir)) {
    try {
      fs.accessSync(dir, fs.constants ? fs.constants.W_OK : 2);
      return path.join(dir, base + '.watchhouse.json');
    } catch (e) { /* fall through */ }
  }
  var safe = String(projectPath || base).replace(/[^A-Za-z0-9_-]+/g, '_').slice(-120);
  return path.join(appDataDir(), 'projects', safe + '.json');
}

function emptyConfig() {
  return { version: 1, autoSync: false, folders: [], seqState: {} };
}

// Names used before the rename to WatchHouse (version 1.1: Edit.prproj.ordnerwache.json,
// version 1.0: Edit.ordnerwache.json).
function legacyConfigFiles(projectPath) {
  if (!projectPath) return [];
  var dir = path.dirname(projectPath);
  return [
    path.join(dir, path.basename(projectPath) + '.ordnerwache.json'),
    path.join(dir, path.basename(projectPath, path.extname(projectPath)) + '.ordnerwache.json')
  ];
}

function loadConfig(projectPath) {
  var file = configFile(projectPath);
  var c = readJSON(file, null);
  if (!c && !fs.existsSync(file)) {
    // Move a config with the old name to the new name, so no stale file stays behind.
    var legacy = legacyConfigFiles(projectPath);
    for (var li = 0; li < legacy.length && !c; li++) {
      if (legacy[li] === file) continue;
      c = readJSON(legacy[li], null);
      if (c && Array.isArray(c.folders)) {
        try { fs.renameSync(legacy[li], file); } catch (e) { /* read-only: keep using the old file */ }
      }
    }
  }
  c = c || emptyConfig();
  if (!Array.isArray(c.folders)) c.folders = [];
  if (!c.seqState) c.seqState = {};
  c.folders.forEach(function (r) {
    if (!r.opts) r.opts = {};
    if (!r.overrides) r.overrides = {};
  });
  return c;
}

function saveConfig(projectPath, config) { writeJSON(configFile(projectPath), config); }

function configMtime(projectPath) {
  try { return fs.statSync(configFile(projectPath)).mtimeMs; } catch (e) { return 0; }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Adds a watch folder. Returns { root } or { error: { key, path } } (key = i18n text).
function addRoot(config, absPath, projectPath, bin) {
  var abs = normPath(absPath);
  var projectDir = path.dirname(projectPath);
  var clash = rootClash(config, abs, projectDir, null);
  if (clash) return { error: clash };
  var root = {
    id: newId(),
    path: abs,
    rel: false,
    bin: bin || null,
    opts: { sub: true, seq: null, flt: null, label: -1 },
    overrides: {}
  };
  config.folders.push(root);
  return { root: root };
}

// Watch folders must not overlap, or files would be imported twice.
function rootClash(config, abs, projectDir, ignoreId) {
  for (var i = 0; i < config.folders.length; i++) {
    if (config.folders[i].id === ignoreId) continue;
    var other = resolveRootPath(config.folders[i], projectDir);
    if (pathKey(other) === pathKey(abs)) return { key: 'errAlreadyWatched', path: abs };
    if (isInside(abs, other)) return { key: 'errInsideWatched', path: other };
    if (isInside(other, abs)) return { key: 'errContainsWatched', path: other };
  }
  return null;
}

// Changes the folder of a watch folder. Returns an error { key, path } or null.
function setRootPath(root, absPath, projectPath, config) {
  var abs = normPath(absPath);
  if (config) {
    var clash = rootClash(config, abs, path.dirname(projectPath), root.id);
    if (clash) return clash;
  }
  root.path = root.rel ? toRelative(abs, path.dirname(projectPath)) : abs;
  return null;
}

function setRelative(root, rel, projectPath) {
  var projectDir = path.dirname(projectPath);
  var abs = resolveRootPath(root, projectDir);
  root.rel = !!rel;
  root.path = root.rel ? toRelative(abs, projectDir) : normPath(abs);
}

// Effective options of a folder. Children inherit from their parents.
// seq and flt may be null, which means "detect automatically".
function effective(root, rel) {
  var o = root.opts || {};
  var out = {
    sub: o.sub !== false,
    seq: o.seq === undefined ? null : o.seq,
    flt: o.flt === undefined ? null : o.flt,
    label: typeof o.label === 'number' ? o.label : -1
  };
  if (rel) {
    var parts = rel.split('/');
    var acc = '';
    for (var i = 0; i < parts.length; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      var ov = root.overrides && root.overrides[acc];
      if (ov) {
        Object.keys(ov).forEach(function (k) { if (ov[k] !== undefined) out[k] = ov[k]; });
      }
    }
  }
  return out;
}

// Sets one option on a folder. Descendants lose their own value for that
// option, so they inherit the new one.
function setOption(root, rel, key, value) {
  if (!root.overrides) root.overrides = {};
  if (!rel) {
    root.opts[key] = value;
  } else {
    var ov = root.overrides[rel] || (root.overrides[rel] = {});
    ov[key] = value;
  }
  var prefix = rel ? rel + '/' : '';
  Object.keys(root.overrides).forEach(function (k) {
    if (prefix === '' || k.indexOf(prefix) === 0) {
      if (k !== rel) delete root.overrides[k][key];
    }
    if (root.overrides[k] && Object.keys(root.overrides[k]).length === 0) delete root.overrides[k];
  });
}

// ---------------------------------------------------------------------------
// Ignore filter

function compileIgnore(list) {
  var names = {};
  var regexes = [];
  (list || []).forEach(function (raw) {
    var s = String(raw).trim();
    if (!s) return;
    var m = /^\/(.+)\/([gimsuy]*)$/.exec(s);
    if (m) {
      try { regexes.push(new RegExp(m[1], m[2].indexOf('i') < 0 ? m[2] + 'i' : m[2])); } catch (e) { /* bad regex */ }
    } else {
      names[s.toLowerCase()] = true;
    }
  });
  return function (name) {
    if (names[name.toLowerCase()]) return true;
    for (var i = 0; i < regexes.length; i++) if (regexes[i].test(name)) return true;
    return false;
  };
}

// ---------------------------------------------------------------------------
// File system helpers

function readDir(dir) {
  var out = { dirs: [], files: [] };
  var names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  names.forEach(function (n) {
    if (isHiddenName(n)) return;
    var abs = path.join(dir, n);
    var st;
    try { st = fs.statSync(abs); } catch (e) { return; }
    if (st.isDirectory()) out.dirs.push(n);
    else if (st.isFile()) out.files.push({ name: n, abs: abs, st: st });
  });
  out.dirs.sort(naturalCompare);
  out.files.sort(function (a, b) { return naturalCompare(a.name, b.name); });
  return out;
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// Case-insensitive lookup of a sub path. Returns the absolute path or null.
function subPath(dir) {
  var cur = dir;
  for (var i = 1; i < arguments.length; i++) {
    var want = String(arguments[i]).toLowerCase();
    var names;
    try { names = fs.readdirSync(cur); } catch (e) { return null; }
    var hit = null;
    for (var j = 0; j < names.length; j++) {
      if (names[j].toLowerCase() === want) { hit = names[j]; break; }
    }
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function listMedia(dir, exts, recursive, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (!dir || depth > 12) return out;
  var r = readDir(dir);
  if (!r) return out;
  r.files.forEach(function (f) {
    if (exts.indexOf(extOf(f.name)) >= 0) out.push(f);
  });
  if (recursive) {
    r.dirs.forEach(function (d) { listMedia(path.join(dir, d), exts, true, out, depth + 1); });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image sequences

var SEQ_RE = /^(.*?)(\d{3,})\.([A-Za-z0-9]+)$/;
// A numbered image at the end of a run of 1-2 frames may be the start of an
// image sequence that is still being rendered. It is imported as a single
// file only when no frame of that run changed for this long.
var SEQ_QUIET_MS = 10000;

// Splits files into image sequences and single files. A sequence needs
// at least 3 consecutive frames with 3 or more digits at the end of the name.
function groupSequences(files) {
  var groups = {};
  var singles = [];
  files.forEach(function (f) {
    var m = SEQ_RE.exec(f.name);
    if (!m || IMAGE_EXTENSIONS.indexOf(m[3].toLowerCase()) < 0) { singles.push(f); return; }
    var key = m[1].toLowerCase() + '|' + m[3].toLowerCase() + '|' + m[2].length;
    (groups[key] || (groups[key] = [])).push({ n: parseInt(m[2], 10), f: f });
  });
  var seqs = [];
  Object.keys(groups).forEach(function (key) {
    var list = groups[key].sort(function (a, b) { return a.n - b.n; });
    var run = [list[0]];
    var flush = function () {
      if (run.length >= 3) {
        seqs.push({ first: run[0].f, last: run[run.length - 1].f, frames: run.length,
          files: run.map(function (x) { return x.f; }) });
      } else {
        var newest = 0;
        run.forEach(function (x) { newest = Math.max(newest, x.f.st ? x.f.st.mtimeMs : 0); });
        run.forEach(function (x) {
          if (last) x.f.seqWait = newest;
          singles.push(x.f);
        });
      }
    };
    var last = false;
    for (var i = 1; i < list.length; i++) {
      if (list[i].n === list[i - 1].n + 1) run.push(list[i]);
      else { flush(); run = [list[i]]; }
    }
    last = true;   // only the newest run can still grow into a sequence
    flush();
  });
  singles.sort(function (a, b) { return naturalCompare(a.name, b.name); });
  return { seqs: seqs, singles: singles };
}

// ---------------------------------------------------------------------------
// Camera card detection. Each rule returns the media of the card, or null.
// Media of a camera card always go flat into the bin of the card folder.

var VIDEO_EXT = ['mp4', 'mxf', 'mov', 'mts', 'm2ts', 'm2t', 'avi'];

function fileExistsCI(dir, name) {
  var p = subPath(dir, name);
  return !!p && !isDir(p);
}

function lowestR3D(rdc) {
  var files = listMedia(rdc, ['r3d'], false);
  return files.length ? [files[0]] : [];
}

var CAMERA_RULES = [
  {
    type: 'Sony a7S',
    need: ['private'],
    test: function (d) { return isDir(subPath(d, 'PRIVATE', 'M4ROOT', 'CLIP')); },
    collect: function (d, exts) {
      var out = listMedia(subPath(d, 'PRIVATE', 'M4ROOT', 'CLIP'), VIDEO_EXT, false);
      return listMedia(subPath(d, 'DCIM'), exts, true, out);
    }
  },
  {
    type: 'Sony FS/XAVC',
    need: ['xdroot'],
    test: function (d) { return isDir(subPath(d, 'XDROOT', 'Clip')); },
    collect: function (d) { return listMedia(subPath(d, 'XDROOT', 'Clip'), VIDEO_EXT, false); }
  },
  {
    type: 'AVCHD',
    need: ['private', 'avchd', 'bdmv'],
    test: function (d) {
      return isDir(subPath(d, 'PRIVATE', 'AVCHD', 'BDMV', 'STREAM')) ||
        isDir(subPath(d, 'AVCHD', 'BDMV', 'STREAM')) || isDir(subPath(d, 'BDMV', 'STREAM'));
    },
    collect: function (d) {
      var s = subPath(d, 'PRIVATE', 'AVCHD', 'BDMV', 'STREAM') || subPath(d, 'AVCHD', 'BDMV', 'STREAM') ||
        subPath(d, 'BDMV', 'STREAM');
      return listMedia(s, ['mts', 'm2ts'], false);
    }
  },
  {
    type: 'Canon XF',
    need: ['contents'],
    test: function (d) { return isDir(subPath(d, 'CONTENTS', 'CLIPS001')); },
    collect: function (d) { return listMedia(subPath(d, 'CONTENTS', 'CLIPS001'), ['mxf'], true); }
  },
  {
    type: 'Panasonic P2',
    need: ['contents'],
    test: function (d) { return isDir(subPath(d, 'CONTENTS', 'VIDEO')) && isDir(subPath(d, 'CONTENTS', 'CLIP')); },
    collect: function (d) { return listMedia(subPath(d, 'CONTENTS', 'VIDEO'), ['mxf'], false); }
  },
  {
    type: 'XDCAM-EX',
    need: ['bpav'],
    test: function (d) { return isDir(subPath(d, 'BPAV', 'CLPR')); },
    collect: function (d) { return listMedia(subPath(d, 'BPAV', 'CLPR'), ['mp4'], true); }
  },
  {
    type: 'XDCAM-HD',
    need: ['clip'],
    test: function (d) {
      return isDir(subPath(d, 'Clip')) &&
        (fileExistsCI(d, 'MEDIAPRO.XML') || fileExistsCI(d, 'DISCMETA.XML') || isDir(subPath(d, 'Sub')));
    },
    collect: function (d) { return listMedia(subPath(d, 'Clip'), ['mxf'], false); }
  },
  {
    type: 'Sony HDV',
    need: ['hvr'],
    test: function (d) { return isDir(subPath(d, 'HVR')); },
    collect: function (d) { return listMedia(subPath(d, 'HVR'), ['m2t', 'mts', 'avi'], true); }
  },
  {
    type: 'RED',
    test: function (d, entries) {
      return /\.(rdm|rdc)$/i.test(path.basename(d)) ||
        entries.dirs.some(function (n) { return /\.rdc$/i.test(n); });
    },
    collect: function (d, exts, entries) {
      if (/\.rdc$/i.test(path.basename(d))) return lowestR3D(d);
      var out = [];
      entries.dirs.forEach(function (n) {
        if (/\.rdc$/i.test(n)) out = out.concat(lowestR3D(path.join(d, n)));
        else if (/\.rdm$/i.test(n)) {
          var r = readDir(path.join(d, n));
          if (r) r.dirs.forEach(function (m) {
            if (/\.rdc$/i.test(m)) out = out.concat(lowestR3D(path.join(d, n, m)));
          });
        }
      });
      // Sound files next to the clips are allowed (RED .wav).
      return out.concat(listMedia(d, ['wav'], false));
    }
  },
  {
    type: 'ARRIRAW',
    test: function (d, entries) {
      return entries.dirs.slice(0, 50).some(function (n) { return listMedia(path.join(d, n), ['ari'], false).length > 0; });
    },
    collect: function (d, exts, entries) {
      var out = [];
      entries.dirs.forEach(function (n) {
        var frames = listMedia(path.join(d, n), ['ari'], false);
        if (!frames.length) {
          out = out.concat(listMedia(path.join(d, n), ['mxf', 'mov', 'wav'], false));
          return;
        }
        var g = groupSequences(frames);
        g.seqs.forEach(function (s) { out.push({ name: s.first.name, abs: s.first.abs, st: s.last.st, seq: true, frames: s.frames }); });
        g.singles.forEach(function (f) { out.push(f); });
      });
      return out;
    }
  },
  {
    type: 'DCIM',
    need: ['dcim'],
    test: function (d) { return isDir(subPath(d, 'DCIM')); },
    collect: function (d, exts) { return listMedia(subPath(d, 'DCIM'), exts, true); }
  }
];

function detectCamera(dir, entries) {
  var names = {};
  entries.dirs.forEach(function (n) { names[n.toLowerCase()] = true; });
  for (var i = 0; i < CAMERA_RULES.length; i++) {
    var rule = CAMERA_RULES[i];
    // Cheap check first: the rule's top-level folder must exist.
    if (rule.need && !rule.need.some(function (n) { return names[n]; })) continue;
    try {
      if (rule.test(dir, entries)) return rule;
    } catch (e) { /* unreadable */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stability: wait until a file is completely written.

function finderBusy(st) {
  // Finder gives files that are still being copied the creation date 1984-01-24.
  if (process.platform !== 'darwin' || !st.birthtime) return false;
  var y = st.birthtime.getUTCFullYear();
  return y === 1984 || y === 1946;
}

// iCloud Drive files that are only in the cloud have no blocks on disk.
// Start the download and wait until the file is local.
var downloadRequested = {};
var datalessCache = {};
var SF_DATALESS = 0x40000000;

// A file without blocks may be compressed or sparse. Only the macOS
// "dataless" flag means it is really waiting in the cloud.
function cloudOnly(st, abs) {
  if (process.platform !== 'darwin' || st.size === 0 || st.blocks !== 0) return false;
  var key = abs + '|' + st.mtimeMs;
  if (datalessCache[key] === undefined) {
    try {
      var out = require('child_process').execFileSync('/usr/bin/stat', ['-f', '%Xf', abs], { encoding: 'utf8' });
      datalessCache[key] = (parseInt(out.trim(), 16) & SF_DATALESS) !== 0;
    } catch (e) {
      datalessCache[key] = false;
    }
  }
  return datalessCache[key];
}

function requestDownload(abs) {
  var t = downloadRequested[abs];
  if (t && Date.now() - t < 60000) return;   // ask again after a minute
  downloadRequested[abs] = Date.now();
  try {
    require('child_process').execFile('/usr/bin/brctl', ['download', abs], function () {});
  } catch (e) { /* not available */ }
}

function isStable(key, st, now, pending, stableMs, abs) {
  if (abs && cloudOnly(st, abs)) {
    requestDownload(abs);
    pending[key] = { size: st.size, mtime: st.mtimeMs, t: now };
    return false;
  }
  if (st.size === 0 || finderBusy(st)) {
    pending[key] = { size: st.size, mtime: st.mtimeMs, t: now };
    return false;
  }
  var age = now - st.mtimeMs;
  if (age < stableMs) {
    pending[key] = { size: st.size, mtime: st.mtimeMs, t: now };
    return false;
  }
  // The size and the date must stay the same for stableMs. Copies with
  // preserved dates (rsync -a, cp -p, unzip) look old while still growing.
  var p = pending[key];
  if (p && p.size === st.size && p.mtime === st.mtimeMs && now - p.t >= stableMs) {
    delete pending[key];
    return true;
  }
  if (!p || p.size !== st.size || p.mtime !== st.mtimeMs) pending[key] = { size: st.size, mtime: st.mtimeMs, t: now };
  return false;
}

// ---------------------------------------------------------------------------
// Plan: which bins to create and which files to import.
//
// ctx = { config, projectPath, settings, imported (Set of pathKey),
//         now, pending (object), attempted (object: key -> mtime) }

function rootBinRef(root, abs) {
  if (root.bin && (root.bin.nodeId || (root.bin.path && root.bin.path.length))) {
    return { nodeId: root.bin.nodeId || null, path: root.bin.path || [] };
  }
  return { nodeId: null, path: [path.basename(abs)] };
}

function buildPlan(ctx) {
  var config = ctx.config;
  var settings = ctx.settings;
  var projectDir = path.dirname(ctx.projectPath);
  var now = ctx.now || Date.now();
  var pending = ctx.pending || {};
  var attempted = ctx.attempted || {};
  var imported = ctx.imported;
  var allowed = (settings.allowedExtensions || []).map(function (e) { return String(e).toLowerCase().replace(/^\./, ''); });
  var ignored = compileIgnore(settings.ignoredFolders);
  var stableMs = settings.stableMs || 1500;

  var plan = { bins: [], imports: [], refresh: [], waiting: 0, offline: [], seqUpdates: {}, loops: [], cameras: {} };
  var importIndex = {};

  var planned = {};   // pathKey -> true, so overlapping folders never import twice
  var visited = {};   // real paths of walked folders (symlink loops)

  function addImport(base, sub, label, file, isSeq, frames, lastSt, seqFiles) {
    if (isSeq && seqFiles) {
      // The sequence may already be in the project under another frame
      // (frames added in front of it, or the first frame deleted).
      for (var i = 0; i < seqFiles.length; i++) {
        if (imported.has(pathKey(seqFiles[i].abs))) { file = seqFiles[i]; break; }
      }
    }
    var key = pathKey(file.abs);
    if (planned[key]) return;
    planned[key] = true;
    if (imported.has(key)) {
      if (isSeq) {
        var prev = config.seqState[key] || 0;
        if (frames > prev) {
          if (prev > 0 && isStable(key + '#seq', lastSt || file.st, now, pending, stableMs)) {
            plan.refresh.push({ path: file.abs, frames: frames,
              alt: [file.abs.normalize('NFC'), file.abs.normalize('NFD')] });
            plan.seqUpdates[key] = frames;
          } else if (prev === 0) {
            plan.seqUpdates[key] = frames;
          } else {
            plan.waiting++;
          }
        }
      }
      return;
    }
    var mt = (lastSt || file.st).mtimeMs;
    // Tried before and still not in the project (unsupported, or Ingest copy).
    if (attempted[key] === mt) { plan.loops.push(file.abs); return; }
    if (!isStable(key, isSeq && lastSt ? lastSt : file.st, now, pending, stableMs, file.abs)) { plan.waiting++; return; }
    var ik = JSON.stringify([base.nodeId, base.path, sub, label, !!isSeq]);
    var entry = importIndex[ik];
    if (!entry) {
      entry = importIndex[ik] = { base: base, sub: sub, label: label, seq: !!isSeq, files: [], mtimes: [] };
      plan.imports.push(entry);
    }
    entry.files.push(file.abs);
    entry.mtimes.push(mt);
    if (isSeq) plan.seqUpdates[key] = frames;
  }

  function walk(root, base, absDir, rel, sub, flat) {
    var o = effective(root, rel);
    var real;
    try { real = pathKey(fs.realpathSync(absDir)); } catch (e) { return; }
    if (visited[real]) return;
    visited[real] = true;
    var entries = readDir(absDir);
    if (!entries) return;

    var cam = detectCamera(absDir, entries);
    if (cam && o.flt !== false) {
      plan.cameras[rel || '.'] = cam.type;
      cam.collect(absDir, allowed, entries).forEach(function (f) {
        if (allowed.indexOf(extOf(f.name)) < 0) return;
        addImport(base, sub, o.label, f, !!f.seq, f.frames || 0, f.st);
      });
      return;
    }

    var files = entries.files.filter(function (f) { return allowed.indexOf(extOf(f.name)) >= 0; });
    var grouped = groupSequences(files);
    var seqOn = o.seq === null ? grouped.seqs.length > 0 : o.seq;
    // With SEQ on or automatic, wait before a possible first frame is imported alone.
    var single = function (f) {
      if (o.seq !== false && f.seqWait && now - f.seqWait < SEQ_QUIET_MS && !imported.has(pathKey(f.abs))) {
        plan.waiting++;
        return;
      }
      addImport(base, sub, o.label, f, false);
    };
    if (seqOn) {
      grouped.seqs.forEach(function (s) { addImport(base, sub, o.label, s.first, true, s.frames, s.last.st, s.files); });
      grouped.singles.forEach(single);
    } else {
      files.forEach(function (f) { if (f.seqWait !== undefined) single(f); else addImport(base, sub, o.label, f, false); });
    }

    if (!o.sub) return;
    // An explicit FLT off on a subfolder wins over a flattened parent.
    var flatten = o.flt === null ? flat : o.flt;
    entries.dirs.forEach(function (d) {
      if (ignored(d)) return;
      var r2 = rel ? rel + '/' + d : d;
      var o2 = effective(root, r2);
      var intoParent = flatten && o2.flt !== false;
      var sub2 = intoParent ? sub : sub.concat([d]);
      if (!intoParent) plan.bins.push({ base: base, sub: sub2, label: o2.label });
      walk(root, base, path.join(absDir, d), r2, sub2, flatten);
    });
  }

  config.folders.forEach(function (root) {
    var abs = resolveRootPath(root, projectDir);
    if (!isDir(abs)) { plan.offline.push(root.id); return; }
    var base = rootBinRef(root, abs);
    plan.bins.push({ base: base, sub: [], label: effective(root, '').label });
    walk(root, base, abs, '', [], false);
  });
  return plan;
}

// ---------------------------------------------------------------------------
// Folder tree for the watch-folders manager.

function describeTree(root, projectPath, settings, maxDepth) {
  var projectDir = path.dirname(projectPath);
  var abs = resolveRootPath(root, projectDir);
  var ignored = compileIgnore(settings.ignoredFolders);
  var allowed = (settings.allowedExtensions || []).map(function (e) { return String(e).toLowerCase(); });
  maxDepth = maxDepth || 8;

  function node(dir, rel, depth) {
    var entries = readDir(dir);
    var n = { name: rel ? path.basename(dir) : path.basename(abs), rel: rel, abs: dir, offline: !entries,
      camera: null, seqDetected: false, files: 0, children: [] };
    if (!entries) return n;
    var cam = detectCamera(dir, entries);
    if (cam) { n.camera = cam.type; return n; }
    var files = entries.files.filter(function (f) { return allowed.indexOf(extOf(f.name)) >= 0; });
    n.files = files.length;
    n.seqDetected = groupSequences(files).seqs.length > 0;
    if (depth >= maxDepth) return n;
    entries.dirs.forEach(function (d) {
      if (ignored(d)) return;
      n.children.push(node(path.join(dir, d), rel ? rel + '/' + d : d, depth + 1));
    });
    return n;
  }
  return node(abs, '', 0);
}

// Paths of drag shelves and temp folders (e.g. BarDrop, Dropover, Yoink).
// Dropping a folder through such an app gives a copy, not the real folder.
function isStagingPath(p) {
  var n = normPath(p);
  var lib = path.join(os.homedir(), 'Library') + path.sep;
  // iCloud Drive, Dropbox, Google Drive and OneDrive live in ~/Library too.
  if (n.indexOf(lib + 'Mobile Documents' + path.sep) === 0 || n.indexOf(lib + 'CloudStorage' + path.sep) === 0) {
    return false;
  }
  return n.indexOf(lib) === 0 ||
    /^\/(private\/)?(var\/folders|tmp)\//.test(n) ||
    /\\AppData\\Local\\Temp\\/i.test(n);
}

// Looks for folders with this name in the usual user folders.
function findFoldersByName(name, maxDepth) {
  var home = os.homedir();
  var bases = ['Desktop', 'Documents', 'Downloads', 'Movies', 'Pictures', 'Music']
    .map(function (b) { return path.join(home, b); });
  try {
    fs.readdirSync('/Volumes').forEach(function (v) { bases.push(path.join('/Volumes', v)); });
  } catch (e) { /* not macOS */ }
  var out = [];
  var want = String(name).toLowerCase();
  maxDepth = maxDepth || 3;
  function walk(dir, depth) {
    if (out.length >= 20) return;
    var names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    names.forEach(function (n) {
      if (isHiddenName(n) || n === 'Library' || /\.(app|photoslibrary|fcpbundle)$/i.test(n)) return;
      var abs = path.join(dir, n);
      if (!isDir(abs)) return;
      if (n.toLowerCase() === want) out.push(abs);
      if (depth < maxDepth) walk(abs, depth + 1);
    });
  }
  bases.forEach(function (b) { if (isDir(b)) walk(b, 1); });
  return out;
}

// Proposes a folder for a bin, from the media paths of clips in it.
// samples = [{ media, depth }] where depth is the sub-bin depth below the bin.
function suggestFolder(samples) {
  var votes = {};
  var best = null;
  (samples || []).forEach(function (s) {
    if (!s.media) return;
    var d = path.dirname(s.media);
    for (var i = 0; i < s.depth; i++) d = path.dirname(d);
    var k = pathKey(d);
    votes[k] = votes[k] || { path: d, n: 0 };
    votes[k].n++;
    if (!best || votes[k].n > best.n) best = votes[k];
  });
  return best && isDir(best.path) ? best.path : null;
}

module.exports = {
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  DEFAULT_EXTENSIONS: DEFAULT_EXTENSIONS,
  appDataDir: appDataDir,
  LABELS: LABELS,
  AE_LABELS: AE_LABELS,
  labelsFor: labelsFor,
  normPath: normPath,
  pathKey: pathKey,
  isInside: isInside,
  resolveRootPath: resolveRootPath,
  loadSettings: loadSettings,
  saveSettings: saveSettings,
  configFile: configFile,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  configMtime: configMtime,
  emptyConfig: emptyConfig,
  addRoot: addRoot,
  setRootPath: setRootPath,
  setRelative: setRelative,
  effective: effective,
  setOption: setOption,
  compileIgnore: compileIgnore,
  groupSequences: groupSequences,
  detectCamera: detectCamera,
  readDir: readDir,
  isStable: isStable,
  buildPlan: buildPlan,
  describeTree: describeTree,
  suggestFolder: suggestFolder,
  isStagingPath: isStagingPath,
  findFoldersByName: findFoldersByName,
  isDir: isDir
};
