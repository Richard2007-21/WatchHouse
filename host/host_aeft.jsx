/*
 * WatchHouse – ExtendScript side for After Effects (needs host_common.jsx).
 * Same API as host_ppro.jsx. Project folders play the role of bins.
 * After Effects has one open project. Item collections are 1-based.
 */

function ow_aeProjectPath() {
    return app.project && app.project.file ? app.project.file.fsName : '';
}

function ow_isFolder(item) {
    return item instanceof FolderItem;
}

function ow_mediaPath(item) {
    try {
        if (item instanceof FootageItem && item.mainSource instanceof FileSource && item.mainSource.file) {
            return item.mainSource.file.fsName;
        }
    } catch (e) {}
    return '';
}

// Calls fn(item, depth, names) for every item below folder.
function ow_walk(folder, fn, depth, names) {
    depth = depth || 0;
    names = names || [];
    for (var i = 1; i <= folder.numItems; i++) {
        var it = folder.item(i);
        if (fn(it, depth, names) === true) return true;
        if (ow_isFolder(it)) {
            names.push(it.name);
            var stop = ow_walk(it, fn, depth + 1, names);
            names.pop();
            if (stop) return true;
        }
    }
    return false;
}

function ow_findById(id) {
    try { return app.project.itemByID(parseInt(id, 10)); } catch (e) { return null; }
}

function ow_pathOf(item) {
    var names = [];
    var cur = item;
    while (cur && cur !== app.project.rootFolder) {
        names.unshift(cur.name);
        cur = cur.parentFolder;
    }
    return names;
}

var OW_created = 0;

function ow_childFolder(parent, name, create) {
    var ci = null;
    for (var i = 1; i <= parent.numItems; i++) {
        var it = parent.item(i);
        if (!ow_isFolder(it)) continue;
        if (it.name === name) return it;
        if (!ci && String(it.name).toLowerCase() === String(name).toLowerCase()) ci = it;
    }
    if (ci) return ci;
    if (!create) return null;
    var f = app.project.items.addFolder(name);
    f.parentFolder = parent;
    OW_created++;
    return f;
}

function ow_resolveBin(base, sub, create, cache) {
    var key = ow_stringify([base.nodeId, base.path, sub]);
    if (cache && cache[key]) return cache[key];
    var bin = null;
    if (base.nodeId) {
        bin = ow_findById(base.nodeId);
        if (bin && !ow_isFolder(bin)) bin = null;
    }
    if (!bin) {
        bin = app.project.rootFolder;
        for (var i = 0; i < base.path.length && bin; i++) bin = ow_childFolder(bin, base.path[i], create);
    }
    for (var j = 0; j < sub.length && bin; j++) bin = ow_childFolder(bin, sub[j], create);
    if (cache && bin) cache[key] = bin;
    return bin;
}

// Ids of all items directly in the root folder.
function ow_rootIds() {
    var ids = {};
    var root = app.project.rootFolder;
    for (var i = 1; i <= root.numItems; i++) ids[root.item(i).id] = true;
    return ids;
}

// Our label index 0-15 maps to the After Effects labels 1-16.
function ow_setLabel(item, label) {
    if (label >= 0) {
        try { item.label = label + 1; } catch (e) {}
    }
}

function ow_importOne(file, seq, psdAs) {
    var io = new ImportOptions(new File(file));
    if (seq) {
        io.sequence = true;
        io.forceAlphabetical = false;
    }
    var ext = String(file).toLowerCase().replace(/^.*\./, '');
    if (!seq && (ext === 'psd' || ext === 'ai' || ext === 'eps' || ext === 'pdf')) {
        var as = psdAs === 'comp' ? ImportAsType.COMP :
            psdAs === 'compCropped' ? ImportAsType.COMP_CROPPED_LAYERS : ImportAsType.FOOTAGE;
        if (io.canImportAs(as)) io.importAs = as;
    }
    return app.project.importFile(io);
}

// ---------------------------------------------------------------------------
// API

function ow_ping() {
    return ow_stringify({ ok: true, version: app.version, host: 'AEFT' });
}

function ow_listProjects() {
    try {
        var p = ow_aeProjectPath();
        var out = [];
        if (app.project) {
            out.push({ path: p, name: app.project.file ? File.decode(app.project.file.name) : 'Unbenannt', active: true });
        }
        return ow_stringify({ projects: out });
    } catch (e) {
        return ow_err(e);
    }
}

function ow_state(projPath) {
    try {
        if (ow_norm(ow_aeProjectPath()) !== ow_norm(projPath)) return ow_stringify({ error: 'Projekt nicht offen' });
        var paths = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var mp = ow_mediaPath(app.project.item(i));
            if (mp) paths.push(mp);
        }
        return ow_stringify({ paths: paths });
    } catch (e) {
        return ow_err(e);
    }
}

// payload = { bins:[{base,sub,label}], imports:[{base,sub,label,seq,files}],
//             refresh:[{path}], psdImportAs, forceLabels, notify }
function ow_apply(projPath, payload) {
    var res = { created: 0, imported: 0, refreshed: 0, importedPaths: [], errors: [] };
    var undo = false;
    try {
        var pl = ow_parse(payload);
        if (ow_norm(ow_aeProjectPath()) !== ow_norm(projPath)) return ow_stringify({ error: 'Projekt nicht offen' });
        app.beginUndoGroup('WatchHouse');
        undo = true;
        var cache = {};
        var i, j;
        OW_created = 0;

        for (i = 0; i < pl.bins.length; i++) {
            var b = pl.bins[i];
            var before = OW_created;
            var bin = ow_resolveBin(b.base, b.sub, true, cache);
            if (!bin) { res.errors.push('MISSING_BIN:' + b.sub.join('/')); continue; }
            if (b.label >= 0 && (OW_created > before || pl.forceLabels)) ow_setLabel(bin, b.label);
        }

        for (i = 0; i < pl.imports.length; i++) {
            var imp = pl.imports[i];
            var target = ow_resolveBin(imp.base, imp.sub, true, cache);
            if (!target) { res.errors.push('MISSING_BIN:' + imp.sub.join('/')); continue; }
            var known = ow_rootIds();
            for (j = 0; j < imp.files.length; j++) {
                try {
                    var it = ow_importOne(imp.files[j], imp.seq, pl.psdImportAs);
                    if (!it) continue;
                    it.parentFolder = target;
                    ow_setLabel(it, imp.label);
                    res.imported++;
                    var mp = ow_mediaPath(it);
                    if (mp) res.importedPaths.push(mp);
                } catch (e2) {
                    res.errors.push(imp.files[j].replace(/^.*[\/\\]/, '') + ': ' + String(e2.message || e2));
                }
            }
            // Photoshop/Illustrator comps create an extra layers folder in the root.
            var root = app.project.rootFolder;
            for (j = root.numItems; j >= 1; j--) {
                var extra = root.item(j);
                if (!known[extra.id] && extra !== target) extra.parentFolder = target;
            }
        }

        if (pl.refresh && pl.refresh.length) {
            var want = {};
            for (i = 0; i < pl.refresh.length; i++) {
                var r = pl.refresh[i];
                want[ow_norm(r.path)] = true;
                // Unicode forms (NFC/NFD) of the same path, ExtendScript cannot normalize.
                for (j = 0; r.alt && j < r.alt.length; j++) want[ow_norm(r.alt[j])] = true;
            }
            for (i = 1; i <= app.project.numItems; i++) {
                var item = app.project.item(i);
                if (!want[ow_norm(ow_mediaPath(item))]) continue;
                try {
                    item.mainSource.reload();
                    res.refreshed++;
                } catch (e4) {
                    res.errors.push('Sequenz: ' + String(e4));
                }
            }
        }

        res.created = OW_created;
        if (pl.notify) writeLn(pl.notify);
        app.endUndoGroup();
        return ow_stringify(res);
    } catch (e) {
        if (undo) { try { app.endUndoGroup(); } catch (e5) {} }
        res.error = String(e && e.message ? e.message : e);
        return ow_stringify(res);
    }
}

// After Effects shows notifications in the Info panel.
function ow_notify(msg) {
    try { writeLn(msg); } catch (e) {}
    return ow_stringify({ ok: true });
}

function ow_selectedBins() {
    try {
        var sel = app.project.selection;
        var out = [];
        for (var i = 0; i < sel.length; i++) {
            var it = sel[i];
            if (!ow_isFolder(it)) continue;
            var samples = [];
            ow_walk(it, function (c, depth) {
                if (samples.length >= 60) return true;
                var mp = ow_mediaPath(c);
                if (mp) samples.push({ media: mp, depth: depth });
            });
            out.push({ nodeId: String(it.id), name: it.name, path: ow_pathOf(it), samples: samples });
        }
        return ow_stringify({ project: ow_aeProjectPath(), bins: out });
    } catch (e) {
        return ow_err(e);
    }
}
