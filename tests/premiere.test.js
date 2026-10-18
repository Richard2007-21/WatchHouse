// WatchHouse test: real core + engine + host_ppro.jsx against a mock Premiere object model.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const EXT = path.join(__dirname, '..');
const core = require(EXT + '/lib/core.js');
const { createEngine } = require(EXT + '/lib/engine.js');

const TMP = process.argv[2] || fs.mkdtempSync(path.join(require('os').tmpdir(), 'watchhouse-'));
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// Isolate settings: point HOME at the temp dir.
process.env.HOME = TMP;
require('os').homedir = () => TMP;

function touch(p, content = 'x', ageMs = 60000) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
}

// ---------------- mock Premiere ----------------
let nodeCounter = 0;
const T = { CLIP: 1, BIN: 2, ROOT: 3, FILE: 4 };
function makeItem(type, name, media) {
  const kids = [];
  const it = {
    type, name, nodeId: 'n' + (++nodeCounter), media: media || '', label: -1, meta: '', kids,
    children: null,
    getMediaPath() { return this.media; },
    createBin(n) { const b = makeItem(T.BIN, n); kids.push(b); return b; },
    setColorLabel(l) { this.label = l; },
    getProjectMetadata() { return this.meta; },
    setProjectMetadata(m) { this.meta = m; },
    canChangeMediaPath() { return true; },
    changeMediaPath(p) { this.relinked = (this.relinked || 0) + 1; return true; },
    refreshMedia() { return ''; }
  };
  it.children = new Proxy({}, {
    get(_, k) { if (k === 'numItems') return kids.length; const i = Number(k); return Number.isInteger(i) ? kids[i] : undefined; }
  });
  return it;
}
const projPath = path.join(TMP, 'Projekt', 'Test.prproj');
fs.mkdirSync(path.dirname(projPath), { recursive: true });
fs.writeFileSync(projPath, '');
const rootItem = makeItem(T.ROOT, 'root');
const importLog = [];
const project = {
  path: projPath, name: 'Test.prproj', rootItem,
  importFiles(files, suppress, bin, seq) {
    importLog.push({ files: files.slice(), suppress, bin: bin.name, seq });
    files.forEach(f => {
      if (/\.bad$/.test(f)) return; // unsupported
      const it = makeItem(T.CLIP, path.basename(f), f);
      it.seq = seq;
      bin.kids.push(it);
    });
    return true;
  },
  addPropertyToProjectMetadataSchema() { return true; }
};
const events = [];
const app = {
  version: '26.0', project, projects: Object.assign([project], { numProjects: 1 }),
  setSDKEventMessage(m) { events.push(m); },
  getCurrentProjectViewSelection() { return []; }
};
const sandbox = { app, ProjectItemType: T, ExternalObject: { AdobeXMPScript: {} },
  XMPMeta: function (s) { this.s = s; this.setProperty = (ns, k, v) => { this.v = v; }; this.serialize = () => 'date=' + this.v; } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(EXT + '/host/host_common.jsx', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(EXT + '/host/host_ppro.jsx', 'utf8'), sandbox);
const evalScript = code => Promise.resolve(String(vm.runInContext(code, sandbox)));

function binByPath(names) {
  let b = rootItem;
  for (const n of names) { b = b.kids.find(k => k.type === T.BIN && k.name === n); if (!b) return null; }
  return b;
}
function allMedia() {
  const out = [];
  (function w(b) { b.kids.forEach(k => { if (k.type === T.BIN) w(k); else out.push(k); }); })(rootItem);
  return out;
}

// ---------------- fixture folders ----------------
const W = path.join(TMP, 'Medien');
touch(path.join(W, 'Musik', 'song.mp3'));
touch(path.join(W, 'Musik', 'Whoosh', 'w1.wav'));
touch(path.join(W, 'Musik', 'readme.txt'));
touch(path.join(W, 'Musik', '.DS_Store'));
touch(path.join(W, 'proxies', 'p.mov'));
touch(path.join(W, 'Neuer Ordner', 'x.mov'));
touch(path.join(W, 'Render', 'shot_0001.png'));
touch(path.join(W, 'Render', 'shot_0002.png'));
touch(path.join(W, 'Render', 'shot_0003.png'));
touch(path.join(W, 'Render', 'frame_00.png'));
touch(path.join(W, 'Render', 'frame_01.png'));
touch(path.join(W, 'Render', 'frame_02.png'));
touch(path.join(W, 'Karte A7S', 'PRIVATE', 'M4ROOT', 'CLIP', 'C0001.MP4'));
touch(path.join(W, 'Karte A7S', 'PRIVATE', 'M4ROOT', 'CLIP', 'C0001M01.XML'));
touch(path.join(W, 'Karte A7S', 'PRIVATE', 'M4ROOT', 'THMBNL', 'C0001T01.JPG'));
touch(path.join(W, 'Karte A7S', 'DCIM', '100MSDCF', 'DSC0001.JPG'));
touch(path.join(W, 'RED', 'A001.RDM', 'A001_C001.RDC', 'A001_C001_001.R3D'));
touch(path.join(W, 'RED', 'A001.RDM', 'A001_C001.RDC', 'A001_C001_002.R3D'));
touch(path.join(W, 'Drohne', 'DJI_0001.MP4'));
touch(path.join(W, 'kaputt.bad'));

(async () => {
  // Unit tests of the pure functions
  const g = core.groupSequences(['a_001.png', 'a_002.png', 'a_003.png', 'b_00.png', 'b_01.png', 'b_02.png', 'c_010.jpg', 'c_020.jpg']
    .map(n => ({ name: n, abs: '/' + n, st: {} })));
  assert.strictEqual(g.seqs.length, 1, 'one sequence');
  assert.strictEqual(g.seqs[0].frames, 3);
  assert.strictEqual(g.singles.length, 5);
  const ig = core.compileIgnore(['proxies', '/_AME/']);
  assert(ig('PROXIES') && ig('x_AME_y') && !ig('Musik'));

  const settings = core.loadSettings();
  settings.allowedExtensions = settings.allowedExtensions.concat(['bad']);
  settings.stableMs = 300;
  core.saveSettings(settings);

  const cfg = core.loadConfig(projPath);
  assert(!core.addRoot(cfg, W, projPath, null).error);
  assert(core.addRoot(cfg, path.join(W, 'Musik'), projPath, null).error, 'inner folder rejected');
  assert(core.addRoot(cfg, TMP, projPath, null).error, 'outer folder rejected');
  const root = cfg.folders[0];
  core.setOption(root, 'Drohne', 'label', 9);
  core.setOption(root, 'Musik', 'label', 13);
  core.setOption(root, 'Musik/Whoosh', 'label', 5);
  core.setOption(root, 'Musik', 'label', 13); // parent change clears child override
  assert.strictEqual(core.effective(root, 'Musik/Whoosh').label, 13, 'inheritance');
  core.setRelative(root, true, projPath);
  assert.strictEqual(root.path, '../Medien');
  cfg.autoSync = true;
  core.saveConfig(projPath, cfg);
  assert(fs.existsSync(path.join(TMP, 'Projekt', 'Test.prproj.watchhouse.json')), 'sidecar config');

  // Engine run
  const logs = [];
  const engine = createEngine({ core, evalScript, onLog: l => logs.push(l.kind + ': ' + l.msg) });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sync = () => engine.command({ cmd: 'sync', project: projPath });
  await sync();          // first look: files are noted
  await sleep(400);
  await sync();          // second look: unchanged files are imported

  const media = allMedia().map(m => path.relative(W, m.media)).sort();
  console.log('Imported:', media);
  console.log('Bins:', JSON.stringify((function t(b) { return b.kids.filter(k => k.type === T.BIN).map(k => ({ [k.name + (k.label >= 0 ? '#' + k.label : '')]: t(k) })); })(rootItem)));
  console.log('Log:', logs);

  assert(binByPath(['Medien', 'Musik', 'Whoosh']), 'nested bin');
  assert(!binByPath(['Medien', 'proxies']), 'ignored proxies');
  assert(!binByPath(['Medien', 'Neuer Ordner']), 'ignored new folder');
  assert(media.includes('Musik/song.mp3'));
  assert(!media.some(m => m.endsWith('.txt')), 'txt filtered');
  assert(!media.some(m => m.includes('THMBNL')), 'camera thumbnails skipped');
  assert(media.includes('Karte A7S/PRIVATE/M4ROOT/CLIP/C0001.MP4'));
  assert(binByPath(['Medien', 'Karte A7S']).kids.length === 2, 'camera flattened into card bin');
  assert(media.includes('RED/A001.RDM/A001_C001.RDC/A001_C001_001.R3D') && !media.some(m => m.endsWith('_002.R3D')), 'RED first span only');
  const seqItem = allMedia().find(m => m.media.endsWith('shot_0001.png'));
  assert(seqItem && seqItem.seq === true, 'sequence imported as sequence');
  assert(!allMedia().some(m => /shot_000[23]/.test(m.media)), 'no extra frames');
  assert(allMedia().filter(m => /frame_0/.test(m.media)).length === 3, '2-digit frames are single files');
  assert.strictEqual(binByPath(['Medien', 'Drohne']).label, 9, 'bin label');
  assert.strictEqual(allMedia().find(m => m.name === 'DJI_0001.MP4').label, 9, 'clip label');
  assert.strictEqual(allMedia().find(m => m.name === 'w1.wav').label, 13, 'inherited clip label');

  // Second sync: no duplicates
  const before = allMedia().length;
  await engine.command({ cmd: 'sync', project: projPath });
  assert.strictEqual(allMedia().length, before, 'no duplicates');
  assert(logs.some(l => /kaputt\.bad/.test(l)), 'unsupported file warned once, not retried');

  // File still being written must wait
  touch(path.join(W, 'Musik', 'neu.wav'), 'abc', 0);
  await engine.command({ cmd: 'sync', project: projPath });
  assert(!allMedia().some(m => m.name === 'neu.wav'), 'fresh file waits');
  await sleep(400);
  await sync();
  assert(allMedia().some(m => m.name === 'neu.wav'), 'file imported after it is stable');

  // Growing sequence is refreshed
  touch(path.join(W, 'Render', 'shot_0004.png'));
  await engine.command({ cmd: 'sync', project: projPath });
  await sleep(400);
  await sync();
  assert(seqItem.relinked >= 1, 'growing sequence relinked');
  assert.strictEqual(allMedia().length, before + 1, 'still no duplicates');

  // Manually imported file in another bin is not imported again
  touch(path.join(W, 'Drohne', 'DJI_0002.MP4'));
  rootItem.kids.push(makeItem(T.CLIP, 'DJI_0002.MP4', path.join(W, 'Drohne', 'DJI_0002.MP4')));
  const n2 = allMedia().length;
  await sync(); await sleep(400); await sync();
  assert.strictEqual(allMedia().length, n2, 'manual import counts as present');

  // Offline folder and relink
  const cfg2 = core.loadConfig(projPath);
  core.setRootPath(cfg2.folders[0], path.join(TMP, 'gibtsnicht'), projPath);
  core.saveConfig(projPath, cfg2);
  await engine.command({ cmd: 'sync', project: projPath });
  assert(logs.some(l => /Offline/.test(l)), 'offline reported');

  // Linked bin suggestion
  const sug = core.suggestFolder([{ media: path.join(W, 'Musik', 'Whoosh', 'w1.wav'), depth: 1 }, { media: path.join(W, 'Musik', 'song.mp3'), depth: 0 }]);
  assert.strictEqual(sug, path.join(W, 'Musik'));

  // buildPlan edge cases on a separate folder
  const W2 = path.join(TMP, 'Edge');
  touch(path.join(W2, 'A', 'a.wav'));
  touch(path.join(W2, 'A', 'B', 'b.wav'));
  touch(path.join(W2, 'S', 's_002.png')); touch(path.join(W2, 'S', 's_003.png')); touch(path.join(W2, 'S', 's_004.png'));
  fs.symlinkSync(W2, path.join(W2, 'A', 'loop'));
  const cfgE = core.emptyConfig();
  const rootE = core.addRoot(cfgE, W2, projPath, null).root;
  core.setOption(rootE, 'A', 'flt', true);
  core.setOption(rootE, 'A/B', 'flt', false);
  const importedE = new Set([core.pathKey(path.join(W2, 'S', 's_002.png'))]);
  cfgE.seqState[core.pathKey(path.join(W2, 'S', 's_002.png'))] = 3;
  touch(path.join(W2, 'S', 's_001.png'));
  const pend = {};
  const ctxE = t => ({ config: cfgE, projectPath: projPath, settings: core.loadSettings(), imported: importedE, now: t, pending: pend, attempted: {} });
  core.buildPlan(ctxE(Date.now()));
  const planE = core.buildPlan(ctxE(Date.now() + 400));
  const importsE = planE.imports.map(i => i.sub.join('/') + ':' + i.files.map(f => path.basename(f)).join(','));
  console.log('Edge imports:', importsE, 'refresh:', planE.refresh.map(r => path.basename(r.path)));
  assert(importsE.includes('A:a.wav'), 'flattened folder');
  assert(importsE.includes('A/B:b.wav'), 'explicit FLT off wins over flattened parent');
  assert(!planE.imports.some(i => i.seq), 'prepended frame does not re-import the sequence');
  assert.deepStrictEqual(planE.refresh.map(r => path.basename(r.path)), ['s_002.png'], 'existing sequence refreshed');
  const allFiles = [].concat.apply([], planE.imports.map(i => i.files));
  assert.strictEqual(allFiles.length, new Set(allFiles).size, 'symlink loop imports nothing twice');
  assert(core.isStagingPath(path.join(require('os').homedir(), 'Library', 'Application Support', 'BarDrop', 'x')));
  assert(!core.isStagingPath(path.join(require('os').homedir(), 'Library', 'Mobile Documents', 'x')), 'iCloud Drive is no staging path');

  // Tree for the manager
  const cfg3 = core.loadConfig(projPath);
  core.setRootPath(cfg3.folders[0], W, projPath);
  const tree = core.describeTree(cfg3.folders[0], projPath, core.loadSettings());
  const cam = tree.children.find(c => c.name === 'Karte A7S');
  assert.strictEqual(cam.camera, 'Sony a7S');
  assert(tree.children.find(c => c.name === 'Render').seqDetected);

  console.log('Events:', events);
  console.log('\nALLE TESTS OK');
})().catch(e => { console.error('FEHLER', e); process.exit(1); });
