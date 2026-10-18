/* WatchHouse – main panel, watch-folders manager, settings and help. */
(function () {
  'use strict';
  var core = OW.core;
  var cs = OW.cs;
  var path = OW.path;
  var T = OW.t;
  var $ = function (id) { return document.getElementById(id); };
  var IS_WIN = OW.require('os').platform() === 'win32';

  var project = null;          // { path, name }
  var status = { projects: [], busy: false };
  var localEngine = null;      // fallback when the background extension does not answer
  var bgAlive = false;
  var folded = {};             // rootId|rel -> true
  var treeCache = {};          // rootId -> folder tree; folding does not re-read the disk
  var watchedSig = '';         // avoids rebuilding the watched list every 2 s
  var view = 'main';

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function icon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    var use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#' + name);
    svg.appendChild(use);
    return svg;
  }

  function fmtTime(t) {
    var d = new Date(t);
    var p = function (n) { return n < 10 ? '0' + n : n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function addLog(line) {
    var li = el('li', line.kind);
    li.appendChild(el('span', 't', fmtTime(line.t)));
    li.appendChild(document.createTextNode(line.msg));
    var log = $('log');
    log.insertBefore(li, log.firstChild);
    while (log.children.length > 150) log.removeChild(log.lastChild);
    $('logEmpty').hidden = true;
  }

  function localLog(msg, kind) { addLog({ t: Date.now(), msg: msg, kind: kind || 'info' }); }

  // Errors from core.js are { key, path } so they can be translated.
  function errText(err) {
    return typeof err === 'string' ? err : T(err.key, { path: err.path });
  }

  function command(cmd) {
    if (project && !cmd.project) cmd.project = project.path;
    if (localEngine) localEngine.command(cmd);
    else OW.send(OW.EVT_CMD, cmd);
  }

  function canEdit() {
    if (!project) { localLog(T('noProjectLog'), 'warn'); return false; }
    if (!project.path) { localLog(T('saveFirstLog'), 'warn'); return false; }
    return true;
  }

  function withConfig(fn) {
    if (!canEdit()) return;
    var cfg = core.loadConfig(project.path);
    var r = fn(cfg);
    if (r === false) return;
    core.saveConfig(project.path, cfg);
    command({ cmd: 'reload' });
    renderFolders();
    renderStatus();
  }

  function pickFolders(multi, title) {
    var r = window.cep.fs.showOpenDialogEx(!!multi, true, title || T('pickAdd'), '');
    if (!r || r.err || !r.data) return [];
    return r.data.map(function (p) {
      p = String(p);
      if (!/^file:\/\//i.test(p)) return p;
      try { return decodeURIComponent(p.replace(/^file:\/\/(localhost)?/i, '')); } catch (e) { return p; }
    });
  }

  // ---------------------------------------------------------------- language

  function applyI18n() {
    document.documentElement.lang = OW.lang();
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (n) {
      n.textContent = T(n.getAttribute('data-i18n'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-title]'), function (n) {
      n.title = T(n.getAttribute('data-i18n-title'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-lang]'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-lang') === OW.lang());
    });
    if (IS_WIN) $('showConfig').textContent = T('showConfig_win');
    setViewTitle();
    setupNativeMenus();
    watchedSig = '';
    renderStatus();
    renderFolders(true);
  }

  function setLanguage(code) {
    if (code === OW.lang()) return;
    OW.setLang(code);
    applyI18n();
    localLog(T('langChanged'), 'ok');
    command({ cmd: 'reload' });
  }

  // ---------------------------------------------------------------- dialog

  function dialog(title, body, okText) {
    return new Promise(function (resolve) {
      $('dlgTitle').textContent = title;
      var b = $('dlgBody');
      b.innerHTML = '';
      b.appendChild(body);
      $('dlgOk').textContent = okText || T('ok');
      $('dialog').hidden = false;
      var done = function (v) {
        $('dialog').hidden = true;
        $('dlgOk').onclick = $('dlgCancel').onclick = null;
        resolve(v);
      };
      $('dlgOk').onclick = function () { done(true); };
      $('dlgCancel').onclick = function () { done(false); };
    });
  }

  // ---------------------------------------------------------------- views

  var VIEWS = ['main', 'folders', 'settings', 'help'];
  var VIEW_TITLES = { folders: 'foldersTitle', settings: 'settingsTitle', help: 'helpTitle' };

  function setViewTitle() {
    $('viewName').textContent = VIEW_TITLES[view] ? T(VIEW_TITLES[view]) : 'WatchHouse';
  }

  function show(v) {
    view = v;
    VIEWS.forEach(function (n) { $('view-' + n).hidden = n !== v; });
    $('back').hidden = v === 'main';
    $('settingsBtn').classList.toggle('active', v === 'settings');
    setViewTitle();
    if (v === 'folders') renderFolders();
    if (v === 'settings') renderSettings();
  }

  function projStatus() {
    if (!project) return null;
    var k = core.pathKey(project.path);
    for (var i = 0; i < status.projects.length; i++) {
      if (core.pathKey(status.projects[i].path) === k) return status.projects[i];
    }
    return null;
  }

  function renderStatus() {
    $('proj').textContent = project ? project.name : T('noProject');
    var cfg = project && project.path ? core.loadConfig(project.path) : core.emptyConfig();
    var on = !!cfg.autoSync;
    var hasFolders = cfg.folders.length > 0;
    var ps = projStatus();

    var state = !project ? 'none' : !project.path ? 'save' : status.busy ? 'busy' :
      !hasFolders ? 'empty' : on ? 'on' : 'off';
    var titles = {
      none: ['noProject', ''], save: ['statusSaveTitle', 'statusSaveText'], busy: ['statusBusy', 'statusOnText'],
      empty: ['statusEmptyTitle', 'statusEmptyText'], on: ['statusOnTitle', 'statusOnText'],
      off: ['statusOffTitle', 'statusOffText']
    };
    $('statusCard').className = 'card ' + state;
    $('statusTitle').textContent = T(titles[state][0]);
    $('statusText').textContent = titles[state][1] ? T(titles[state][1]) : '';
    var meta = '';
    if (!bgAlive && !localEngine) meta = T('serviceStarting');
    else if (ps && ps.lastSync) meta = T('lastSync', { time: fmtTime(ps.lastSync) });
    $('statusMeta').textContent = meta;

    var btn = $('btnWatch');
    $('btnWatchLabel').textContent = T(on ? 'btnStop' : 'btnStart');
    $('btnWatchIcon').setAttribute('href', on ? '#i-stop' : '#i-play');
    btn.className = 'big ' + (on ? 'stop' : 'primary');
    btn.disabled = !hasFolders && !on;
    btn.style.opacity = btn.disabled ? '.5' : '';
    $('btnSync').disabled = !hasFolders;

    // Show the steps and a big drop zone until the first folder is linked.
    $('steps').hidden = hasFolders;
    // The drop zone always stays; with folders it is smaller and asks for another one.
    $('drop').classList.toggle('compact', hasFolders);
    $('dropTitle').textContent = T(hasFolders ? 'dropMore' : 'dropTitle');
    $('watched').hidden = !hasFolders;
    renderWatched(cfg);
  }

  function renderWatched(cfg) {
    var dir = project && project.path ? path.dirname(project.path) : '';
    var items = cfg.folders.map(function (r) {
      var abs = core.resolveRootPath(r, dir);
      return { root: r, abs: abs, offline: !core.isDir(abs), label: core.effective(r, '').label };
    });
    var sig = OW.lang() + JSON.stringify(items.map(function (i) { return [i.abs, i.offline, i.label]; }));
    if (sig === watchedSig) return;
    watchedSig = sig;
    $('watchedCount').textContent = String(items.length);
    var ul = $('watchedList');
    ul.innerHTML = '';
    items.forEach(function (i) {
      var li = el('li');
      var sw = el('span', 'sw');
      var lab = OW.labels[i.label];
      sw.style.background = lab ? lab.color : 'transparent';
      if (!lab) sw.style.boxShadow = 'none';
      li.appendChild(i.label >= 0 ? sw : icon('i-folder'));
      li.appendChild(el('span', 'nm', path.basename(i.abs)));
      var p = el('span', 'p', i.abs);
      li.appendChild(p);
      if (i.offline) {
        var off = el('span', 'tag off', T('offline'));
        off.title = T('offlineTip');
        li.appendChild(off);
      }
      li.title = i.abs;
      li.onclick = function () { show('folders'); };
      ul.appendChild(li);
    });
  }

  // ---------------------------------------------------------------- folders manager

  var OPT_NAMES = { sub: 'SUB', rel: 'REL', seq: 'SEQ', flt: 'FLT' };
  var OPT_LEGEND = { sub: 'legSub', rel: 'legRel', seq: 'legSeq', flt: 'legFlt' };

  function optCell(key, checked, auto, onChange, na) {
    // Faded only when an option is on because it was detected automatically.
    var c = el('span', 'opt' + (auto && checked ? ' auto' : '') + (na ? ' na' : ''));
    var i = el('input');
    i.type = 'checkbox';
    i.checked = !!checked;
    var tipKey = auto ? 'optAutoTip' : checked ? 'optOnTip' : 'optOffTip';
    c.title = T(tipKey, { opt: OPT_NAMES[key] }) + ' – ' + T(OPT_LEGEND[key]);
    i.onchange = function () { onChange(i.checked); };
    c.appendChild(i);
    return c;
  }

  function labelCell(value, onChange) {
    var c = el('span', 'lab');
    c.title = T('legLabel');
    var s = el('select');
    var none = el('option', '', T('labelNone'));
    none.value = '-1';
    s.appendChild(none);
    OW.labels.forEach(function (l, i) {
      var o = el('option', '', OW.labelName(i));
      o.value = String(i);
      o.style.background = l.color;
      o.style.color = '#000';
      s.appendChild(o);
    });
    s.value = String(value);
    var paint = function () {
      var v = parseInt(s.value, 10);
      s.style.background = v >= 0 ? OW.labels[v].color : '';
      s.style.color = v >= 0 ? '#000' : '';
    };
    paint();
    s.onchange = function () { paint(); onChange(parseInt(s.value, 10)); };
    c.appendChild(s);
    return c;
  }

  function renderFolders(fromCache) {
    if (view !== 'folders') return;
    if (!fromCache) treeCache = {};
    var tree = $('tree');
    tree.innerHTML = '';
    if (!project || !project.path) { $('treeEmpty').hidden = false; return; }
    var cfg = core.loadConfig(project.path);
    var settings = core.loadSettings();
    $('treeEmpty').hidden = cfg.folders.length > 0;
    $('drop2').hidden = cfg.folders.length === 0;

    cfg.folders.forEach(function (root) {
      var node = treeCache[root.id] || (treeCache[root.id] = core.describeTree(root, project.path, settings, 8));
      renderNode(tree, root, node, 0, false);
    });
  }

  function setAllFolded(root, node, value) {
    folded[root.id + '|' + node.rel] = value;
    node.children.forEach(function (c) { setAllFolded(root, c, value); });
  }

  function renderNode(container, root, node, depth, parentFlat) {
    var o = core.effective(root, node.rel);
    var isRoot = node.rel === '';
    var key = root.id + '|' + node.rel;
    var row = el('div', 'row' + (isRoot ? ' root' : ''));

    var name = el('span', 'name');
    name.style.paddingLeft = (depth * 12) + 'px';
    var fold = el('span', 'fold' + (node.children.length ? '' : ' empty'), folded[key] ? '▸' : '▾');
    fold.title = T('foldTip');
    fold.onclick = function (ev) {
      var v = !folded[key];
      if (ev.altKey) setAllFolded(root, node, v); else folded[key] = v;
      renderFolders(true);
    };
    name.appendChild(fold);
    name.appendChild(icon('i-folder'));
    var nm = el('span', 'nm', node.name);
    nm.title = node.abs;
    name.appendChild(nm);
    if (node.offline) {
      var off = el('span', 'tag off', T('offline'));
      off.title = T('offlineTip');
      name.appendChild(off);
    }
    if (node.camera) {
      var ct = el('span', 'tag cam', node.camera);
      ct.title = T('cameraTip', { type: node.camera });
      name.appendChild(ct);
    }
    if (isRoot && root.bin && root.bin.path && root.bin.path.length) {
      name.appendChild(el('span', 'tag bin', T('binTag', { path: root.bin.path.join('/') })));
    }
    row.appendChild(name);

    var change = function (k) {
      return function (v) { withConfig(function (cfg) { core.setOption(findRoot(cfg, root.id), node.rel, k, v); }); };
    };

    row.appendChild(optCell('sub', o.sub, false, change('sub')));
    // REL only for the watch folder itself
    row.appendChild(optCell('rel', root.rel, false, function (v) {
      withConfig(function (cfg) { core.setRelative(findRoot(cfg, root.id), v, project.path); });
    }, !isRoot));
    // SEQ and FLT: null = detect automatically
    var seqAuto = o.seq === null;
    row.appendChild(optCell('seq', seqAuto ? node.seqDetected : o.seq, seqAuto, change('seq')));
    var fltAuto = o.flt === null;
    var fltVal = fltAuto ? (!!node.camera || parentFlat) : o.flt;
    row.appendChild(optCell('flt', fltVal, fltAuto, change('flt')));
    row.appendChild(labelCell(o.label, function (v) {
      withConfig(function (cfg) { core.setOption(findRoot(cfg, root.id), node.rel, 'label', v); });
      command({ cmd: 'sync', forceLabels: true });
    }));

    var del = el('span', 'del', isRoot ? '✕' : '');
    if (isRoot) {
      del.title = T('removeTip');
      del.onclick = function () {
        dialog(T('removeTitle'), el('p', '', T('removeText', { name: node.name })), T('removeOk')).then(function (ok) {
          if (!ok) return;
          withConfig(function (cfg) { cfg.folders = cfg.folders.filter(function (r) { return r.id !== root.id; }); });
          localLog(T('removed', { name: node.name }), 'ok');
        });
      };
    }
    row.appendChild(del);

    if (isRoot) {
      var pl = el('div', 'pathline', (root.rel ? '↳ ' + T('relPrefix') + ': ' : '') + root.path);
      pl.title = T('pathTip');
      pl.onclick = function () {
        var p = pickFolders(false, T('pickRelink', { name: node.name }));
        if (!p.length) return;
        var err = null;
        withConfig(function (cfg) {
          err = core.setRootPath(findRoot(cfg, root.id), p[0], project.path, cfg);
          return !err;
        });
        if (err) localLog(errText(err), 'warn');
        else localLog(T('relinked', { path: p[0] }), 'ok');
      };
      row.appendChild(pl);
    }
    container.appendChild(row);

    if (!folded[key]) {
      var flat = fltAuto ? (parentFlat || !!node.camera) : o.flt;
      node.children.forEach(function (c) { renderNode(container, root, c, depth + 1, flat); });
    }
  }

  function findRoot(cfg, id) {
    for (var i = 0; i < cfg.folders.length; i++) if (cfg.folders[i].id === id) return cfg.folders[i];
    throw new Error('watch folder not found: ' + id);
  }

  // ---------------------------------------------------------------- adding folders

  // A folder dropped through a drag shelf app (BarDrop, Dropover …) arrives as
  // a temporary copy. Find the real folder with the same name instead.
  function resolveFolders(paths) {
    var out = [];
    var chain = Promise.resolve();
    paths.forEach(function (p) {
      chain = chain.then(function () {
        if (!core.isStagingPath(p)) { out.push(p); return; }
        var name = path.basename(p);
        var found = core.findFoldersByName(name, 3);
        localLog(T('staging', { name: name, dir: path.dirname(p) }), 'warn');
        if (found.length === 1) { out.push(found[0]); return; }
        if (!found.length) {
          var picked = pickFolders(false, T('stagingPick', { name: name }));
          if (picked.length) out.push(picked[0]);
          return;
        }
        var body = el('div');
        body.appendChild(el('p', 'hint', T('stagingMany', { name: name })));
        var sel = el('select');
        sel.style.width = '100%';
        found.forEach(function (f) { var o = el('option', '', f); o.value = f; sel.appendChild(o); });
        body.appendChild(sel);
        return dialog(T('stagingTitle'), body, T('btnAddOk')).then(function (ok) { if (ok) out.push(sel.value); });
      });
    });
    return chain.then(function () { return out; });
  }

  function addFolders(paths) {
    if (!canEdit() || !paths.length) return;
    resolveFolders(paths).then(addResolvedFolders);
  }

  function addResolvedFolders(paths) {
    var added = 0;
    withConfig(function (cfg) {
      paths.forEach(function (p) {
        if (!core.isDir(p)) { localLog(T('notDir', { path: p }), 'warn'); return; }
        var r = core.addRoot(cfg, p, project.path, null);
        if (r.error) localLog(errText(r.error), 'warn');
        else { added++; localLog(T('added', { path: p }), 'ok'); }
      });
      return added > 0;
    });
    if (added) command({ cmd: 'sync' });
  }

  function linkSelectedBins() {
    if (!canEdit()) return;
    OW.evalScript('ow_selectedBins()').then(function (r) {
      var res;
      try { res = JSON.parse(r); } catch (e) { res = { error: r }; }
      if (res.error) { localLog(T('linkFailed', { error: res.error }), 'error'); return; }
      if (!res.bins.length) { localLog(T('linkNoSel'), 'warn'); return; }
      var choices = res.bins.map(function (b) {
        return { bin: b, folder: core.suggestFolder(b.samples) };
      });
      var body = el('div');
      body.appendChild(el('p', 'hint', T('linkHint')));
      choices.forEach(function (c) {
        var row = el('div', 'linkrow');
        row.appendChild(el('b', '', c.bin.path.join(' / ')));
        var p = el('span', 'p' + (c.folder ? '' : ' none'), c.folder || T('linkNone'));
        row.appendChild(p);
        var acts = el('span', 'acts');
        var btn = el('button', '', T('btnChoose'));
        btn.onclick = function () {
          var picked = pickFolders(false, T('pickForBin', { name: c.bin.name }));
          if (picked.length) { c.folder = picked[0]; p.textContent = c.folder; p.className = 'p'; }
        };
        acts.appendChild(btn);
        row.appendChild(acts);
        body.appendChild(row);
      });
      return dialog(T('linkTitle'), body, T('btnLinkOk')).then(function (ok) {
        if (!ok) return;
        var n = 0;
        withConfig(function (cfg) {
          choices.forEach(function (c) {
            if (!c.folder) return;
            var a = core.addRoot(cfg, c.folder, project.path, { nodeId: c.bin.nodeId, path: c.bin.path });
            if (a.error) localLog(errText(a.error), 'warn');
            else { n++; localLog(T('linked', { name: c.bin.name, path: c.folder }), 'ok'); }
          });
          return n > 0;
        });
        if (n) command({ cmd: 'sync' });
      });
    });
  }

  // ---------------------------------------------------------------- drag and drop

  function droppedPaths(dt) {
    var out = [];
    var i;
    if (dt.files) {
      for (i = 0; i < dt.files.length; i++) if (dt.files[i].path) out.push(dt.files[i].path);
    }
    if (!out.length) {
      var uris = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\r?\n/);
      uris.forEach(function (u) {
        u = u.trim();
        if (/^file:\/\//i.test(u)) {
          var p;
          try { p = decodeURIComponent(u.replace(/^file:\/\/(localhost)?/i, '')); } catch (e) { return; }
          if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
          out.push(p);
        } else if (u.charAt(0) === '/' || /^[A-Za-z]:\\/.test(u)) {
          out.push(u);
        }
      });
    }
    return out.filter(function (p) { return core.isDir(p); });
  }

  function setupDrop() {
    var depth = 0;
    document.addEventListener('dragenter', function (e) {
      e.preventDefault(); depth++; document.body.classList.add('dragover');
    });
    document.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (!depth) document.body.classList.remove('dragover');
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragover');
      var paths = droppedPaths(e.dataTransfer);
      if (paths.length) addFolders(paths);
      else linkSelectedBins();   // bins dragged from the project panel are selected
    });
    var pick = function () { addFolders(pickFolders(true, T('pickAdd'))); };
    ['drop', 'drop2'].forEach(function (id) {
      $(id).onclick = pick;
      $(id).onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    });
  }

  // ---------------------------------------------------------------- settings

  function renderSettings() {
    var s = core.loadSettings();
    $('s-showImportOptions').checked = !!s.showImportOptions;
    $('s-addImportDate').checked = !!s.addImportDate;
    $('s-notifications').checked = !!s.notifications;
    $('s-psdImportAs').value = s.psdImportAs || 'footage';
    $('s-stableMs').value = s.stableMs;
    $('s-allowedExtensions').value = s.allowedExtensions.join(', ');
    $('s-ignoredFolders').value = s.ignoredFolders.join('\n');
  }

  function saveSettings() {
    var s = core.loadSettings();
    s.showImportOptions = $('s-showImportOptions').checked;
    s.addImportDate = $('s-addImportDate').checked;
    s.notifications = $('s-notifications').checked;
    s.psdImportAs = $('s-psdImportAs').value;
    s.stableMs = Math.max(300, parseInt($('s-stableMs').value, 10) || 1500);
    s.allowedExtensions = $('s-allowedExtensions').value.split(/[\s,;]+/)
      .map(function (x) { return x.trim().replace(/^\*?\./, '').toLowerCase(); }).filter(Boolean);
    s.ignoredFolders = $('s-ignoredFolders').value.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    core.saveSettings(s);
    localLog(T('saved'), 'ok');
    command({ cmd: 'reload' });
    show('main');
  }

  function showConfigFile() {
    if (!canEdit()) return;
    var f = core.configFile(project.path);
    if (!OW.require('fs').existsSync(f)) core.saveConfig(project.path, core.loadConfig(project.path));
    if (IS_WIN) window.cep.process.createProcess('explorer.exe', '/select,' + f);
    else window.cep.process.createProcess('/usr/bin/open', '-R', f);
  }

  // ---------------------------------------------------------------- menus

  var MENU_ITEMS = ['folders', 'addFolders', 'linkBins', '-', 'sync', 'toggle', '-', 'settings', 'help', 'openConfig'];
  var MENU_KEYS = {
    folders: 'menuFolders', addFolders: 'menuAdd', linkBins: 'menuLink', sync: 'menuSync', toggle: 'menuToggle',
    settings: 'menuSettings', help: 'menuHelp', openConfig: 'menuConfig'
  };

  function xmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // Panel flyout menu (☰ in the panel tab) and right-click menu, in the current language.
  function setupNativeMenus() {
    var xml = '<Menu>' + MENU_ITEMS.map(function (id) {
      return id === '-' ? '<MenuItem Label="---"/>' :
        '<MenuItem Id="' + id + '" Label="' + xmlEsc(T(MENU_KEYS[id])) + '"/>';
    }).join('') + '</Menu>';
    try { cs.setPanelFlyoutMenu(xml); } catch (e) {}
    try { cs.setContextMenu(xml, function (id) { runMenu(id); }); } catch (e) {}
  }

  function runMenu(id) {
    $('menu').hidden = true;
    switch (id) {
      case 'folders': show('folders'); break;
      case 'linkBins': linkSelectedBins(); break;
      case 'addFolders': addFolders(pickFolders(true, T('pickAdd'))); break;
      case 'sync': command({ cmd: 'sync' }); break;
      case 'toggle': command({ cmd: 'toggle' }); setTimeout(renderStatus, 300); break;
      case 'settings': show('settings'); break;
      case 'help': show('help'); break;
      case 'openConfig': showConfigFile(); break;
    }
  }

  function setupMenus() {
    try {
      cs.addEventListener('com.adobe.csxs.events.flyoutMenuClicked', function (e) {
        runMenu(e.data && e.data.menuId);
      });
    } catch (e) {}
    $('menuBtn').onclick = function (e) { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; };
    document.addEventListener('click', function () { $('menu').hidden = true; });
    Array.prototype.forEach.call(document.querySelectorAll('#menu li[data-cmd]'), function (li) {
      li.onclick = function (e) { e.stopPropagation(); runMenu(li.getAttribute('data-cmd')); };
    });
  }

  // ---------------------------------------------------------------- theme

  function applyTheme() {
    try {
      var c = cs.getHostEnvironment().appSkinInfo.panelBackgroundColor.color;
      var light = (c.red + c.green + c.blue) / 3 > 128;
      document.body.classList.toggle('light', light);
      var hex = function (v) { var h = Math.round(v).toString(16); return h.length < 2 ? '0' + h : h; };
      document.documentElement.style.setProperty('--bg', '#' + hex(c.red) + hex(c.green) + hex(c.blue));
    } catch (e) {}
  }

  // ---------------------------------------------------------------- project tracking

  function refreshProject() {
    return OW.evalScript('ow_listProjects()').then(function (r) {
      var res;
      try { res = JSON.parse(r); } catch (e) { return; }
      var act = null;
      (res.projects || []).forEach(function (p) { if (p.active) act = p; });
      var changed = (act && act.path) !== (project && project.path);
      project = act;
      if (changed) { watchedSig = ''; renderFolders(); }
      renderStatus();
    });
  }

  // ---------------------------------------------------------------- background connection

  function connectBackground() {
    // The background service is up: never run two engines at once.
    var bgUp = function () {
      bgAlive = true;
      if (localEngine) {
        localEngine.stop();
        localEngine = null;
        localLog(T('bgTakeover'), 'ok');
      }
    };
    OW.on(OW.EVT_STATUS, function (s) { bgUp(); status = s; renderStatus(); });
    OW.on(OW.EVT_LOG, function (line) { bgUp(); addLog(line); });
    OW.on(OW.EVT_PONG, function (d) {
      var wasAlive = bgAlive;
      bgUp();
      if (wasAlive && $('log').children.length) return;
      if (d.log) { $('log').innerHTML = ''; d.log.forEach(addLog); }
      if (d.status) { status = d.status; renderStatus(); }
    });
    OW.send(OW.EVT_CMD, { cmd: 'ping' });
    setTimeout(function () {
      if (bgAlive) return;
      try { cs.requestOpenExtension(OW.BG_ID, ''); } catch (e) {}
      setTimeout(function () { if (!bgAlive) OW.send(OW.EVT_CMD, { cmd: 'ping' }); }, 1500);
      setTimeout(function () {
        if (bgAlive) return;
        // Fallback: run the engine in the panel. Works while the panel is open.
        localEngine = OW.require(path.join(OW.extPath, 'lib', 'engine.js')).createEngine({
          core: core, evalScript: OW.evalScript, t: OW.t,
          onLog: addLog, onStatus: function (s) { status = s; renderStatus(); }
        });
        localEngine.start();
        localLog(T('bgFallback'), 'warn');
      }, 4000);
    }, 800);
  }

  // ---------------------------------------------------------------- init

  function init() {
    if (OW.isAE) document.body.classList.add('ae');
    applyTheme();
    cs.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, applyTheme);
    setupMenus();
    setupDrop();
    applyI18n();
    Array.prototype.forEach.call(document.querySelectorAll('[data-lang]'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); setLanguage(b.getAttribute('data-lang')); };
    });
    $('back').onclick = function () { show('main'); };
    $('helpBtn').onclick = function () { show(view === 'help' ? 'main' : 'help'); };
    $('settingsBtn').onclick = function () { show(view === 'settings' ? 'main' : 'settings'); };
    $('btnWatch').onclick = function () { command({ cmd: 'toggle' }); setTimeout(renderStatus, 300); };
    $('btnSync').onclick = function () { command({ cmd: 'sync' }); };
    $('btnFolders').onclick = function () { show('folders'); };
    $('watchedEdit').onclick = function (e) { e.preventDefault(); show('folders'); };
    $('btnAdd').onclick = function () { addFolders(pickFolders(true, T('pickAdd'))); };
    $('btnLink').onclick = linkSelectedBins;
    $('btnApplyLabels').onclick = function () { command({ cmd: 'sync', forceLabels: true }); };
    $('btnSaveSettings').onclick = saveSettings;
    $('btnResetSettings').onclick = function () {
      var keep = core.loadSettings().language;
      var d = JSON.parse(JSON.stringify(core.DEFAULT_SETTINGS));
      d.language = keep;
      core.saveSettings(d);
      renderSettings();
      localLog(T('resetDone'), 'ok');
    };
    $('showConfig').onclick = function (e) { e.preventDefault(); showConfigFile(); };
    OW.loadHost().then(function () {
      refreshProject();
      setInterval(refreshProject, 2000);
      connectBackground();
    });
  }

  init();
})();
