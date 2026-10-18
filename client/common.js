/* WatchHouse – shared helpers for the panel and the background extension. */
(function () {
  'use strict';
  var cs = new CSInterface();
  var nodeRequire = (typeof require === 'function') ? require : (window.cep_node && window.cep_node.require);
  var path = nodeRequire('path');
  var extPath = cs.getSystemPath(SystemPath.EXTENSION);
  var core = nodeRequire(path.join(extPath, 'lib', 'core.js'));
  var i18n = nodeRequire(path.join(extPath, 'lib', 'i18n.js'));

  function evalScript(code) {
    return new Promise(function (resolve) { cs.evalScript(code, resolve); });
  }

  // Makes sure the ExtendScript functions are loaded in the host.
  var host = 'PPRO';
  try { host = cs.getHostEnvironment().appName; } catch (e) {}
  var isAE = host === 'AEFT';
  var uiLocale = '';
  try { uiLocale = cs.getHostEnvironment().appUILocale; } catch (e) {}

  // Current language: the saved choice, else the language of the Adobe app.
  // Read from the settings file at most every 2 s.
  var langCache = { at: 0, lang: 'en' };
  function lang() {
    var now = Date.now();
    if (now - langCache.at > 2000) {
      var s = core.loadSettings();
      langCache.lang = s.language ? i18n.normLang(s.language) : i18n.langFromLocale(uiLocale);
      langCache.at = now;
    }
    return langCache.lang;
  }
  function setLang(code) {
    var s = core.loadSettings();
    s.language = i18n.normLang(code);
    core.saveSettings(s);
    langCache = { at: Date.now(), lang: s.language };
  }
  function t(key, params) { return i18n.t(lang(), key, params, host); }
  function labelName(i) {
    var l = core.labelsFor(host)[i];
    return l ? (lang() === 'de' ? l.name : l.en) : '';
  }

  function loadHost() {
    return evalScript('typeof ow_ping').then(function (t) {
      if (t === 'function') return;
      var dir = path.join(extPath, 'host').replace(/\\/g, '/');
      return evalScript('$.evalFile(' + JSON.stringify(dir + '/host_common.jsx') + ');' +
        '$.evalFile(' + JSON.stringify(dir + (isAE ? '/host_aeft.jsx' : '/host_ppro.jsx')) + ');');
    });
  }

  function send(type, data) {
    var e = new CSEvent(type, 'APPLICATION');
    e.data = JSON.stringify(data || {});
    cs.dispatchEvent(e);
  }

  function on(type, fn) {
    cs.addEventListener(type, function (ev) {
      var d = ev.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = {}; } }
      fn(d || {});
    });
  }

  window.OW = {
    cs: cs, host: host, isAE: isAE, labels: core.labelsFor(host), labelName: labelName,
    i18n: i18n, lang: lang, setLang: setLang, t: t, require: nodeRequire, path: path, extPath: extPath, core: core,
    evalScript: evalScript, loadHost: loadHost, send: send, on: on,
    EVT_CMD: 'com.watchhouse.cmd', EVT_STATUS: 'com.watchhouse.status',
    EVT_LOG: 'com.watchhouse.log', EVT_PONG: 'com.watchhouse.pong',
    BG_ID: 'com.watchhouse.background'
  };
})();
