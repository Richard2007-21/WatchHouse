/*
 * WatchHouse – sync engine. Runs in the hidden background extension
 * (or in the panel if the background extension is not available).
 * Watches folders of all open projects and imports new media.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var i18n = require('./i18n.js');

var TICK_MS = 3000;     // how often the list of open projects is checked
var POLL_MS = 15000;    // full re-scan while auto-sync is on (backup for fs.watch)

function createEngine(opts) {
  var core = opts.core;
  var evalScript = opts.evalScript;   // (code) => Promise<string>
  var onLog = opts.onLog || function () {};
  var onStatus = opts.onStatus || function () {};
  // tr(key, params) returns the text in the current language (lib/i18n.js).
  var tr = opts.t || function (key, params) { return i18n.t('en', key, params); };

  var states = {};        // pathKey(projectPath) -> state
  var queue = Promise.resolve();
  var busy = 0;
  var timer = null;
  var stopped = false;
  var logLines = [];

  function log(msg, kind) {
    var line = { t: Date.now(), msg: msg, kind: kind || 'info' };
    logLines.push(line);
    if (logLines.length > 200) logLines.shift();
    onLog(line);
  }

  // JSON string literal that is also a valid ES3 string literal.
  function q(s) {
    return JSON.stringify(String(s)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  function jsx(code) {
    return evalScript(code).then(function (r) {
      if (r === 'EvalScript error.' || r === undefined || r === null || r === '') {
        throw new Error('ExtendScript-Fehler bei ' + code.slice(0, 40));
      }
      var o = JSON.parse(r);
      if (o && o.error && !o.importedPaths) throw new Error(o.error);
      return o;
    });
  }

  function stateFor(projectPath, name) {
    var key = core.pathKey(projectPath);
    var st = states[key];
    if (!st) {
      st = states[key] = {
        path: projectPath, name: name, config: core.loadConfig(projectPath),
        cfgMtime: core.configMtime(projectPath), watchers: [], watchedKey: '',
        debounce: null, lastPoll: 0, lastSync: 0, lastResult: null,
        pending: {}, attempted: {}, tries: {}, warnedLoops: {}, needsInitialSync: true
      };
    }
    st.name = name || st.name;
    return st;
  }

  function reloadIfChanged(st) {
    var m = core.configMtime(st.path);
    if (m !== st.cfgMtime) {
      st.config = core.loadConfig(st.path);
      st.cfgMtime = m;
      return true;
    }
    return false;
  }

  function saveConfig(st) {
    core.saveConfig(st.path, st.config);
    st.cfgMtime = core.configMtime(st.path);
  }

  // --- watchers ------------------------------------------------------------

  function stopWatchers(st) {
    st.watchers.forEach(function (w) { try { w.close(); } catch (e) {} });
    st.watchers = [];
    st.watchedKey = '';
  }

  function ensureWatchers(st) {
    var dir = path.dirname(st.path);
    var roots = st.config.folders.map(function (r) { return core.resolveRootPath(r, dir); });
    var key = roots.join('\n');
    if (key === st.watchedKey && st.watchers.length) return;
    stopWatchers(st);
    st.watchedKey = key;
    roots.forEach(function (abs) {
      if (!core.isDir(abs)) return;
      try {
        var w = fs.watch(abs, { recursive: true, persistent: false }, function () { schedule(st, 700); });
        w.on('error', function () { try { w.close(); } catch (e) {} });
        st.watchers.push(w);
      } catch (e) {
        // Some drives (network, ExFAT) do not support watching. Polling still works.
      }
    });
  }

  // --- sync ----------------------------------------------------------------

  function schedule(st, delay, options) {
    if (stopped) return;
    if (st.debounce) clearTimeout(st.debounce);
    st.debounce = setTimeout(function () {
      st.debounce = null;
      enqueue(st, options || {});
    }, delay || 0);
  }

  function enqueue(st, options) {
    queue = queue.then(function () { return stopped ? null : sync(st, options); }).catch(function (e) {
      log(tr('errorLog', { msg: e.message }), 'error');
    });
    return queue;
  }

  function sync(st, options) {
    options = options || {};
    if (!st.config.folders.length) {
      if (options.manual) log(tr('noFolders'), 'warn');
      return Promise.resolve();
    }
    busy++;
    emitStatus();
    var settings = core.loadSettings();
    return jsx('ow_state(' + q(st.path) + ')').then(function (state) {
      var imported = new Set(state.paths.map(core.pathKey));
      var plan = core.buildPlan({
        config: st.config, projectPath: st.path, settings: settings, imported: imported,
        now: Date.now(), pending: st.pending, attempted: st.attempted
      });

      plan.loops.forEach(function (p) {
        if (st.warnedLoops[p]) return;
        st.warnedLoops[p] = true;
        log(tr('skippedLoop', { file: path.basename(p) }), 'warn');
      });
      if (plan.offline.length) {
        var names = st.config.folders.filter(function (r) { return plan.offline.indexOf(r.id) >= 0; })
          .map(function (r) { return path.basename(String(r.path)); });
        if (options.manual || !st.warnedOffline) log(tr('offlineLog', { names: names.join(', ') }), 'warn');
        st.warnedOffline = true;
      } else {
        st.warnedOffline = false;
      }

      var fileCount = plan.imports.reduce(function (n, i) { return n + i.files.length; }, 0);
      var hasWork = fileCount > 0 || plan.refresh.length > 0 || options.forceLabels || options.manual ||
        st.needsBins || st.needsInitialSync;
      var seqDirty = Object.keys(plan.seqUpdates).length > 0;
      // Files still being written: look again, slower each round (max 30 s).
      if (plan.waiting > 0) {
        var base = (settings.stableMs || 1500) + 300;
        schedule(st, Math.min(30000, base * Math.pow(2, Math.min(st.waitRounds || 0, 5))));
        st.waitRounds = (st.waitRounds || 0) + 1;
      } else {
        st.waitRounds = 0;
      }
      if (!hasWork) {
        if (seqDirty && !fileCount) { reloadIfChanged(st); mergeSeq(st, plan.seqUpdates); saveConfig(st); }
        return null;
      }

      var payload = {
        bins: plan.bins, imports: plan.imports.map(function (i) {
          return { base: i.base, sub: i.sub, label: i.label, seq: i.seq, files: i.files };
        }),
        refresh: plan.refresh, showOptions: !!settings.showImportOptions,
        addImportDate: !!settings.addImportDate, psdImportAs: settings.psdImportAs || 'footage', forceLabels: !!options.forceLabels, notify: ''
      };
      return jsx('ow_apply(' + q(st.path) + ',' + q(JSON.stringify(payload)) + ')').then(function (res) {
        if (res.error) {
          // The batch failed as a whole: nothing is marked, the next sync tries again.
          log(st.name + ': ' + tr('importAborted', { error: res.error }), 'error');
          return null;
        }
        st.needsBins = false;
        st.needsInitialSync = false;
        // A file whose import threw (Premiere busy, locked file) is tried again,
        // at most 3 times. Everything else is not imported twice.
        var failed = {};
        (res.failed || []).forEach(function (f) { failed[core.pathKey(f)] = true; });
        plan.imports.forEach(function (i) {
          i.files.forEach(function (f, n) {
            var k = core.pathKey(f);
            if (failed[k]) {
              st.tries[k] = (st.tries[k] || 0) + 1;
              if (st.tries[k] < 3) { schedule(st, 5000); return; }
            }
            st.attempted[k] = i.mtimes[n];
          });
        });
        // The panel may have changed the config during the import: reload first.
        reloadIfChanged(st);
        mergeSeq(st, plan.seqUpdates);
        saveConfig(st);
        st.lastSync = Date.now();
        st.lastResult = res;
        var parts = [];
        if (res.imported) parts.push(tr('imported', { n: res.imported }));
        if (res.refreshed < plan.refresh.length) {
          log(tr('seqNotFound', { n: plan.refresh.length - res.refreshed }), 'warn');
        }
        if (res.refreshed) parts.push(tr('seqUpdated', { n: res.refreshed }));
        if (res.created) parts.push(tr('binsCreated', { n: res.created }));
        if (plan.waiting) parts.push(tr('waiting', { n: plan.waiting }));
        var msg = parts.length ? parts.join(', ') : tr('upToDate');
        log(st.name + ': ' + msg, res.errors && res.errors.length ? 'warn' : 'ok');
        (res.errors || []).slice(0, 5).forEach(function (e) {
          // The host marks a missing bin with a code, everything else is passed through.
          log(e.indexOf('MISSING_BIN:') === 0 ? tr('binMissing', { path: e.slice(12) }) : e, 'error');
        });
        if (settings.notifications && (parts.length || options.manual)) {
          return jsx('ow_notify(' + q(tr('notify', { msg: msg })) + ')').catch(function () {});
        }
        return null;
      });
    }).then(function () {
      busy--;
      emitStatus();
    }, function (e) {
      busy--;
      emitStatus();
      throw e;
    });
  }

  function mergeSeq(st, updates) {
    Object.keys(updates).forEach(function (k) { st.config.seqState[k] = updates[k]; });
  }

  // --- main loop -----------------------------------------------------------

  function tick() {
    return jsx('ow_listProjects()').then(function (r) {
      var open = {};
      r.projects.forEach(function (p) {
        if (!p.path) return;
        var st = stateFor(p.path, p.name);
        st.active = p.active;
        open[core.pathKey(p.path)] = true;
        var changed = reloadIfChanged(st);
        if (changed) st.needsBins = true;
        if (st.config.autoSync && st.config.folders.length) {
          ensureWatchers(st);
          var now = Date.now();
          if (st.needsInitialSync || changed || now - st.lastPoll > POLL_MS) {
            st.lastPoll = now;
            schedule(st, 50);
          }
        } else {
          stopWatchers(st);
        }
      });
      Object.keys(states).forEach(function (k) {
        if (!open[k]) { stopWatchers(states[k]); delete states[k]; }
      });
      emitStatus();
    }).catch(function () { /* Premiere busy or no project */ });
  }

  function emitStatus() {
    onStatus(status());
  }

  function status() {
    return {
      busy: busy > 0,
      projects: Object.keys(states).map(function (k) {
        var st = states[k];
        return {
          path: st.path, name: st.name, active: !!st.active, autoSync: !!st.config.autoSync,
          folders: st.config.folders.length, watching: st.watchers.length, lastSync: st.lastSync
        };
      })
    };
  }

  function findState(projectPath) {
    if (projectPath) return states[core.pathKey(projectPath)] || stateFor(projectPath, path.basename(projectPath));
    var keys = Object.keys(states);
    for (var i = 0; i < keys.length; i++) if (states[keys[i]].active) return states[keys[i]];
    return null;
  }

  // --- commands from the panel ---------------------------------------------

  function command(cmd) {
    var st = findState(cmd.project);
    // The panel saved the config just before: always read it again (mtime can be coarse).
    if (st) st.cfgMtime = null;
    switch (cmd.cmd) {
      case 'sync':
        if (!st) return Promise.resolve();
        reloadIfChanged(st);
        return enqueue(st, { manual: true, forceLabels: !!cmd.forceLabels });
      case 'toggle':
        if (!st) return Promise.resolve();
        reloadIfChanged(st);
        st.config.autoSync = cmd.value === undefined ? !st.config.autoSync : !!cmd.value;
        saveConfig(st);
        log(st.name + ': ' + tr(st.config.autoSync ? 'autoSyncOn' : 'autoSyncOff'), 'info');
        if (st.config.autoSync) { ensureWatchers(st); schedule(st, 50); } else stopWatchers(st);
        emitStatus();
        return Promise.resolve();
      case 'reload':
        if (st) { reloadIfChanged(st); st.needsBins = true; if (st.config.autoSync) schedule(st, 50); }
        emitStatus();
        return Promise.resolve();
      case 'status':
        emitStatus();
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  }

  function start() {
    if (timer) return;
    stopped = false;
    log(tr('running'), 'info');
    tick();
    timer = setInterval(tick, TICK_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    // Pending syncs must not run next to the engine that took over.
    stopped = true;
    Object.keys(states).forEach(function (k) {
      stopWatchers(states[k]);
      if (states[k].debounce) { clearTimeout(states[k].debounce); states[k].debounce = null; }
    });
  }

  return { start: start, stop: stop, command: command, status: status, log: log, logLines: function () { return logLines.slice(); } };
}

module.exports = { createEngine: createEngine };
