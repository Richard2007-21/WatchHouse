/*
 * WatchHouse – ExtendScript side for Premiere Pro (needs host_common.jsx).
 * All API functions take plain strings and return a JSON string.
 */

function ow_findProject(projPath) {
    var t = ow_norm(projPath);
    for (var i = 0; i < app.projects.numProjects; i++) {
        var p = app.projects[i];
        if (ow_norm(p.path) === t) return p;
    }
    return null;
}

function ow_isBin(item) {
    return item && item.type === ProjectItemType.BIN;
}

function ow_isMedia(item) {
    return item && (item.type === ProjectItemType.CLIP || item.type === ProjectItemType.FILE);
}

function ow_mediaPath(item) {
    try { return item.getMediaPath() || ''; } catch (e) { return ''; }
}

// Calls fn(item, depth, names) for every item below parent.
function ow_walk(parent, fn, depth, names) {
    depth = depth || 0;
    names = names || [];
    var ch = parent.children;
    if (!ch) return false;
    for (var i = 0; i < ch.numItems; i++) {
        var it = ch[i];
        if (!it) continue;
        if (fn(it, depth, names) === true) return true;
        if (ow_isBin(it)) {
            names.push(it.name);
            var stop = ow_walk(it, fn, depth + 1, names);
            names.pop();
            if (stop) return true;
        }
    }
    return false;
}

function ow_findByNode(root, nodeId) {
    var hit = null;
    ow_walk(root, function (it) {
        if (it.nodeId === nodeId) { hit = it; return true; }
    });
    return hit;
}

function ow_pathOf(root, nodeId) {
    var hit = null;
    ow_walk(root, function (it, depth, names) {
        if (it.nodeId === nodeId) {
            hit = names.slice(0);
            hit.push(it.name);
            return true;
        }
    });
    return hit;
}

var OW_created = 0;

function ow_childBin(parent, name, create) {
    var ch = parent.children;
    var ci = null;
    for (var i = 0; i < ch.numItems; i++) {
        var it = ch[i];
        if (!ow_isBin(it)) continue;
        if (it.name === name) return it;
        if (!ci && String(it.name).toLowerCase() === String(name).toLowerCase()) ci = it;
    }
    if (ci) return ci;
    if (!create) return null;
    var nb = parent.createBin(name);
    OW_created++;
    if (nb && nb.type !== undefined) return nb;
    // Older versions return nothing: search again.
    for (var j = parent.children.numItems - 1; j >= 0; j--) {
        var c = parent.children[j];
        if (ow_isBin(c) && c.name === name) return c;
    }
    return null;
}

function ow_resolveBin(proj, base, sub, create, cache) {
    var key = ow_stringify([base.nodeId, base.path, sub]);
    if (cache && cache[key]) return cache[key];
    var bin = null;
    if (base.nodeId) bin = ow_findByNode(proj.rootItem, base.nodeId);
    if (!bin) {
        bin = proj.rootItem;
        for (var i = 0; i < base.path.length && bin; i++) bin = ow_childBin(bin, base.path[i], create);
    }
    for (var j = 0; j < sub.length && bin; j++) bin = ow_childBin(bin, sub[j], create);
    if (cache && bin) cache[key] = bin;
    return bin;
}

function ow_childIds(bin) {
    var ids = {};
    for (var i = 0; i < bin.children.numItems; i++) ids[bin.children[i].nodeId] = true;
    return ids;
}

function ow_pad(n) { return n < 10 ? '0' + n : String(n); }

function ow_now() {
    var d = new Date();
    return d.getFullYear() + '-' + ow_pad(d.getMonth() + 1) + '-' + ow_pad(d.getDate()) + ' ' +
        ow_pad(d.getHours()) + ':' + ow_pad(d.getMinutes()) + ':' + ow_pad(d.getSeconds());
}

var OW_schemaDone = {};
var OW_DATE_FIELD = 'WatchHouseImportDate';
var OW_PRIVATE_NS = 'http://ns.adobe.com/premierePrivateProjectMetaData/1.0/';

function ow_setImportDate(proj, item, date) {
    try {
        if (ExternalObject.AdobeXMPScript === undefined) {
            ExternalObject.AdobeXMPScript = new ExternalObject('lib:AdobeXMPScript');
        }
        if (!OW_schemaDone[proj.path]) {
            proj.addPropertyToProjectMetadataSchema(OW_DATE_FIELD, 'Import Date', 2);
            OW_schemaDone[proj.path] = true;
        }
        var xmp = new XMPMeta(item.getProjectMetadata());
        xmp.setProperty(OW_PRIVATE_NS, OW_DATE_FIELD, date);
        item.setProjectMetadata(xmp.serialize(), [OW_DATE_FIELD]);
        return true;
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// API

function ow_ping() {
    return ow_stringify({ ok: true, version: app.version });
}

function ow_listProjects() {
    try {
        var out = [];
        var active = app.project ? ow_norm(app.project.path) : '';
        for (var i = 0; i < app.projects.numProjects; i++) {
            var p = app.projects[i];
            out.push({ path: p.path, name: p.name, active: ow_norm(p.path) === active });
        }
        return ow_stringify({ projects: out });
    } catch (e) {
        return ow_err(e);
    }
}

// Media paths of all clips in the project (used for the duplicate check).
function ow_state(projPath) {
    try {
        var proj = ow_findProject(projPath);
        if (!proj) return ow_stringify({ error: 'Projekt nicht offen' });
        var paths = [];
        ow_walk(proj.rootItem, function (it) {
            if (ow_isMedia(it)) {
                var mp = ow_mediaPath(it);
                if (mp) paths.push(mp);
            }
        });
        return ow_stringify({ paths: paths });
    } catch (e) {
        return ow_err(e);
    }
}

// payload = { bins:[{base,sub,label}], imports:[{base,sub,label,seq,files}],
//             refresh:[{path}], showOptions, addImportDate, forceLabels, notify }
function ow_apply(projPath, payload) {
    var res = { created: 0, imported: 0, refreshed: 0, importedPaths: [], errors: [] };
    try {
        var pl = ow_parse(payload);
        var proj = ow_findProject(projPath);
        if (!proj) return ow_stringify({ error: 'Projekt nicht offen' });
        var cache = {};
        var i, j;
        OW_created = 0;

        for (i = 0; i < pl.bins.length; i++) {
            var b = pl.bins[i];
            var before = OW_created;
            var bin = ow_resolveBin(proj, b.base, b.sub, true, cache);
            if (!bin) { res.errors.push('MISSING_BIN:' + b.sub.join('/')); continue; }
            if (b.label >= 0 && (OW_created > before || pl.forceLabels)) {
                try { bin.setColorLabel(b.label); } catch (e1) {}
            }
        }

        var date = ow_now();
        for (i = 0; i < pl.imports.length; i++) {
            var imp = pl.imports[i];
            var target = ow_resolveBin(proj, imp.base, imp.sub, true, cache);
            if (!target) { res.errors.push('MISSING_BIN:' + imp.sub.join('/')); continue; }
            var known = ow_childIds(target);
            try {
                if (imp.seq) {
                    for (j = 0; j < imp.files.length; j++) proj.importFiles([imp.files[j]], !pl.showOptions, target, true);
                } else {
                    proj.importFiles(imp.files, !pl.showOptions, target, false);
                }
            } catch (e2) {
                res.errors.push(String(e2));
            }
            for (j = 0; j < target.children.numItems; j++) {
                var it = target.children[j];
                if (known[it.nodeId]) continue;
                res.imported++;
                var mp = ow_mediaPath(it);
                if (mp) res.importedPaths.push(mp);
                if (imp.label >= 0) { try { it.setColorLabel(imp.label); } catch (e3) {} }
                if (pl.addImportDate && ow_isMedia(it)) ow_setImportDate(proj, it, date);
            }
        }

        if (pl.refresh && pl.refresh.length) {
            var want = {};
            for (i = 0; i < pl.refresh.length; i++) {
                var r = pl.refresh[i];
                want[ow_norm(r.path)] = r.path;
                // Unicode forms (NFC/NFD) of the same path, ExtendScript cannot normalize.
                for (j = 0; r.alt && j < r.alt.length; j++) want[ow_norm(r.alt[j])] = r.path;
            }
            ow_walk(proj.rootItem, function (it) {
                if (!ow_isMedia(it)) return;
                var own = ow_mediaPath(it);
                if (!want[ow_norm(own)]) return;
                var p = own;
                try {
                    // Re-link to the first frame so Premiere reads the new length.
                    if (it.canChangeMediaPath && it.canChangeMediaPath()) it.changeMediaPath(p, true);
                    if (it.refreshMedia) it.refreshMedia();
                    res.refreshed++;
                } catch (e4) {
                    res.errors.push('Sequenz: ' + String(e4));
                }
            });
        }

        res.created = OW_created;
        if (pl.notify) {
            try { app.setSDKEventMessage(pl.notify, 'info'); } catch (e5) {}
        }
        return ow_stringify(res);
    } catch (e) {
        res.error = String(e && e.message ? e.message : e);
        return ow_stringify(res);
    }
}

function ow_notify(msg, kind) {
    try { app.setSDKEventMessage(msg, kind || 'info'); } catch (e) {}
    return ow_stringify({ ok: true });
}

// Selected bins in the project panel, with sample media paths so the
// panel can suggest a folder for each bin.
function ow_selectedBins() {
    try {
        var sel = app.getCurrentProjectViewSelection();
        var out = [];
        if (sel) {
            for (var i = 0; i < sel.length; i++) {
                var it = sel[i];
                if (!ow_isBin(it)) continue;
                var samples = [];
                ow_walk(it, function (c, depth) {
                    if (samples.length >= 60) return true;
                    if (ow_isMedia(c)) {
                        var mp = ow_mediaPath(c);
                        if (mp) samples.push({ media: mp, depth: depth });
                    }
                });
                out.push({
                    nodeId: it.nodeId,
                    name: it.name,
                    path: ow_pathOf(app.project.rootItem, it.nodeId) || [it.name],
                    samples: samples
                });
            }
        }
        return ow_stringify({ project: app.project.path, bins: out });
    } catch (e) {
        return ow_err(e);
    }
}
