// WatchHouse test for After Effects: core + engine + host_aeft.jsx against a mock AE object model.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const EXT = path.join(__dirname, '..');
const TMP = process.argv[2] || fs.mkdtempSync(path.join(require('os').tmpdir(), 'watchhouse-'));
fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
require('os').homedir = () => TMP;
const core = require(EXT + '/lib/core.js');
const { createEngine } = require(EXT + '/lib/engine.js');
const touch = (p, ago = 60000) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); const t = new Date(Date.now() - ago); fs.utimesSync(p, t, t); };

// ---- mock After Effects ----
let nextId = 1; const all = [];
function FolderItem(name) { this.id = nextId++; this.name = name; this.label = 0; this.parentFolder = null; all.push(this); }
function FootageItem(file, seq) { this.id = nextId++; this.name = path.basename(file); this.label = 0; this.mainSource = new FileSource(file); this.seq = seq; all.push(this); }
function FileSource(f) { this.file = { fsName: f }; this.reloads = 0; this.reload = () => { this.reloads++; }; }
function CompItem(name) { this.id = nextId++; this.name = name; this.label = 0; all.push(this); }
const kidsOf = f => all.filter(i => i.parentFolder === f).sort((a, b) => a.name.localeCompare(b.name));
FolderItem.prototype = { get numItems() { return kidsOf(this).length; }, item(i) { return kidsOf(this)[i - 1]; } };
const rootFolder = new FolderItem('root'); all.splice(all.indexOf(rootFolder), 1);
const projFile = path.join(TMP, 'Projekt', 'AE Test.aep'); touch(projFile);
const ImportAsType = { FOOTAGE: 1, COMP: 2, COMP_CROPPED_LAYERS: 3 };
const info = [];
const project = {
  file: { fsName: projFile, name: 'AE Test.aep' }, rootFolder,
  get numItems() { return all.length; }, item(i) { return all[i - 1]; },
  itemByID(id) { return all.find(x => x.id === id) || null; },
  items: { addFolder(n) { const f = new FolderItem(n); f.parentFolder = rootFolder; return f; } },
  selection: [],
  importFile(io) {
    const f = io.file;
    if (/\.bad$/.test(f)) throw new Error('Datei kann nicht importiert werden');
    if (/\.psd$/.test(f) && io.importAs === 2) {
      const lay = new FolderItem(path.basename(f) + ' Ebenen'); lay.parentFolder = rootFolder;
      const c = new CompItem(path.basename(f)); c.parentFolder = rootFolder; return c;
    }
    const it = new FootageItem(f, !!io.sequence); it.parentFolder = rootFolder; return it;
  }
};
function ImportOptions(file) { this.file = file.p; this.canImportAs = () => true; }
const sandbox = { app: { version: '26.0', project, beginUndoGroup() {}, endUndoGroup() {} }, FolderItem, FootageItem, FileSource, CompItem,
  ImportOptions, ImportAsType, File: Object.assign(function (p) { this.p = p; }, { decode: decodeURIComponent }), writeLn: m => info.push(m), BridgeTalk: { appName: 'aftereffects' } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(EXT + '/host/host_common.jsx', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(EXT + '/host/host_aeft.jsx', 'utf8'), sandbox);
const evalScript = code => Promise.resolve(String(vm.runInContext(code, sandbox)));
const folder = names => names.reduce((f, n) => f && kidsOf(f).find(k => k instanceof FolderItem && k.name === n), rootFolder);
const media = () => all.filter(i => i.mainSource);

const W = path.join(TMP, 'Medien');
touch(path.join(W, 'Musik', 'song.mp3'));
touch(path.join(W, 'Musik', 'Whoosh', 'w1.wav'));
touch(path.join(W, 'Grafik', 'logo.psd'));
touch(path.join(W, 'Render', 'r_001.exr')); touch(path.join(W, 'Render', 'r_002.exr')); touch(path.join(W, 'Render', 'r_003.exr'));
touch(path.join(W, 'kaputt.bad'));
touch(path.join(W, 'proxies', 'p.mov'));

(async () => {
  const s = core.loadSettings(); s.allowedExtensions.push('bad'); s.psdImportAs = 'comp'; s.stableMs = 300; core.saveSettings(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const cfg = core.loadConfig(projFile);
  const r = core.addRoot(cfg, W, projFile, null).root;
  core.setOption(r, 'Musik', 'label', 8);
  core.saveConfig(projFile, cfg);
  const logs = [];
  const engine = createEngine({ core, evalScript, onLog: l => logs.push(l.kind + ': ' + l.msg) });
  assert.deepStrictEqual(JSON.parse(await evalScript('ow_listProjects()')).projects[0].path, projFile);
  await engine.command({ cmd: 'sync', project: projFile });
  await sleep(400);
  await engine.command({ cmd: 'sync', project: projFile });
  console.log(logs);
  console.log(all.map(i => (i.parentFolder ? i.parentFolder.name : '-') + ' / ' + i.name + ' L' + i.label + (i.seq ? ' SEQ' : '')).join('\n'));
  assert(folder(['Medien', 'Musik', 'Whoosh']), 'nested folders');
  assert(!folder(['Medien', 'proxies']), 'ignored');
  assert.strictEqual(folder(['Medien', 'Musik']).label, 9, 'folder label (8 -> AE 9)');
  assert.strictEqual(media().find(m => m.name === 'w1.wav').label, 9, 'inherited clip label');
  assert(media().find(m => m.name === 'r_001.exr').seq, 'sequence');
  assert.strictEqual(media().filter(m => /r_00/.test(m.name)).length, 1);
  const comp = all.find(i => i instanceof CompItem);
  assert(comp && comp.parentFolder === folder(['Medien', 'Grafik']), 'psd comp in folder');
  assert(all.find(i => / Ebenen$/.test(i.name)).parentFolder === folder(['Medien', 'Grafik']), 'layers folder moved');
  assert(logs.some(l => /kaputt\.bad/.test(l)), 'import error reported');
  const n = all.length;
  await engine.command({ cmd: 'sync', project: projFile });
  assert.strictEqual(all.length, n, 'no duplicates');
  // Project reopened (new engine, nothing in memory): the PSD comp counts as imported.
  assert(comp.comment && comp.comment.indexOf(path.join(W, 'Grafik', 'logo.psd')) > 0, 'comp tagged with source');
  const engine2 = createEngine({ core, evalScript, onLog: () => {} });
  await engine2.command({ cmd: 'sync', project: projFile });
  await sleep(400);
  await engine2.command({ cmd: 'sync', project: projFile });
  assert.strictEqual(all.filter(i => i instanceof CompItem).length, 1, 'comp not imported again after reopen');
  assert.strictEqual(all.length, n, 'nothing imported again after reopen');
  engine2.stop();
  touch(path.join(W, 'Render', 'r_004.exr'));
  await engine.command({ cmd: 'sync', project: projFile });
  await sleep(400);
  await engine.command({ cmd: 'sync', project: projFile });
  assert(media().find(m => m.name === 'r_001.exr').mainSource.reloads >= 1, 'sequence reloaded');
  project.selection = [folder(['Medien', 'Musik'])];
  const sel = JSON.parse(await evalScript('ow_selectedBins()'));
  assert.deepStrictEqual(sel.bins[0].path, ['Medien', 'Musik']);
  assert.strictEqual(core.suggestFolder(sel.bins[0].samples), path.join(W, 'Musik'));
  console.log('Info-Panel:', info);
  console.log('\nAE TESTS OK');
})().catch(e => { console.error('FEHLER', e); process.exit(1); });
