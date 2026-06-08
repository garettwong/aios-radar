/* AIOS Sync (client) — keeps your ticks + to-dos the same on PC and iPhone.
 *
 * LAST-CHANGE-WINS, both directions: every tick / untick / delete records WHEN it
 * happened. On merge, the most recent action for each item wins — so whichever device
 * you touched last is the "boss" for that item, and the other follows. Cross it off on
 * the phone -> PC follows. Un-cross it on the PC -> phone follows. No device priority.
 *
 * Everything is AES-encrypted with your HQ password before it leaves the page; the
 * cloud (a free Google Apps Script store) only ever sees gibberish.
 *
 * Note: to-do ADDs sync; to-do delete/edit sync is basic for now (can upgrade later).
 * Turn on: tap ☁ Sync, paste your Web App URL. Inert until configured.
 */
(function () {
  "use strict";
  var URL_KEY = "aios_sync_url", PW_KEY = "hq_pw_v1";
  var CHECK_KEY = "hq_checks_v1", DEL_KEY = "hq_deleted_v1", ORDER_KEY = "hq_order_v1", TODO_KEY = "aios_todos_v1";
  var CHECK_LOG = "aios_checks_log", DEL_LOG = "aios_deleted_log";   // {key:{s:0|1,t:ms}} — the real synced truth
  var _set = localStorage.setItem.bind(localStorage);

  function getURL() { try { return localStorage.getItem(URL_KEY) || ""; } catch (e) { return ""; } }
  function getPW() { try { return localStorage.getItem(PW_KEY) || ""; } catch (e) { return ""; } }
  function active() { return !!getURL() && !!getPW() && !!(window.crypto && window.crypto.subtle); }

  /* ---- crypto: PBKDF2-SHA256(150k) -> AES-GCM-256; blob = base64(salt16|iv12|ct) ---- */
  function b64e(buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function b64d(str) { var s = atob(str), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  function deriveKey(pw, salt) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 150000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
  }
  function encryptJSON(obj, pw) {
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(pw, salt).then(function (key) { return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj))); })
      .then(function (ct) { var out = new Uint8Array(28 + ct.byteLength); out.set(salt, 0); out.set(iv, 16); out.set(new Uint8Array(ct), 28); return b64e(out.buffer); });
  }
  function decryptB64(str, pw) {
    var raw = b64d(str), salt = raw.slice(0, 16), iv = raw.slice(16, 28), ct = raw.slice(28);
    return deriveKey(pw, salt).then(function (key) { return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct); }).then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }

  /* ---- helpers ---- */
  function parseObj(s) { try { var o = JSON.parse(s || "{}"); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; } }
  function parseArr(s) { try { var a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function nowMs() { return Date.now(); }

  // a "log" is {key:{s:0|1,t:ms}}. s=1 means checked/deleted, s=0 means cleared. t = when it last changed.
  function logToMap(log) { var m = {}; for (var k in log) { if (log[k] && log[k].s === 1) m[k] = 1; } return m; }
  function mergeLog(a, b) {
    a = a || {}; b = b || {}; var out = {}, keys = {}, k;
    for (k in a) keys[k] = 1; for (k in b) keys[k] = 1;
    for (k in keys) { var x = a[k], y = b[k]; out[k] = (!x) ? y : (!y) ? x : ((y.t > x.t) ? y : x); }
    return out;
  }
  function canonLog(log) { var ks = Object.keys(log).sort(), o = {}; ks.forEach(function (k) { o[k] = log[k]; }); return JSON.stringify(o); }
  function canonMap(mapStr) { var o = parseObj(mapStr), ks = Object.keys(o).sort(), s = {}; ks.forEach(function (k) { s[k] = o[k]; }); return JSON.stringify(s); }
  // seed a log from a plain {key:1} map (for items already ticked before logging existed) at t=1 (any real toggle beats it)
  function seedLog(log, mapStr) { var m = parseObj(mapStr); for (var k in m) { if (!log[k]) log[k] = { s: 1, t: 1 }; } return log; }
  // read the remote log; if the store is still old-format ({key:1} map), treat it as a seeded log
  function remoteLog(rkv, logField, mapField) { if (rkv[logField]) return parseObj(rkv[logField]); var seed = {}, m = parseObj(rkv[mapField]); for (var k in m) seed[k] = { s: 1, t: 1 }; return seed; }
  // a local tick/untick happened: diff the new map vs the log's current state, stamp the changes with "now"
  function recordToggles(logKey, newMapStr) {
    var log = parseObj(localStorage.getItem(logKey)), nm = parseObj(newMapStr), eff = logToMap(log), k, t = nowMs();
    for (k in nm) { if (eff[k] !== 1) log[k] = { s: 1, t: t }; }      // newly checked
    for (k in eff) { if (nm[k] !== 1) log[k] = { s: 0, t: t }; }      // newly unchecked
    _set(logKey, JSON.stringify(log));
  }
  function mergeTodos(a, b) {
    var map = {}, seen = {}, out = [];
    (a || []).forEach(function (t) { if (t && t.id != null) map[t.id] = t; });
    (b || []).forEach(function (t) { if (t && t.id != null && !(t.id in map)) map[t.id] = t; });
    (a || []).concat(b || []).forEach(function (t) { if (t && t.id != null && !seen[t.id]) { seen[t.id] = 1; out.push(map[t.id]); } });
    return out;
  }

  function gatherKV() {
    return {
      aios_checks_log: localStorage.getItem(CHECK_LOG) || "{}",
      aios_deleted_log: localStorage.getItem(DEL_LOG) || "{}",
      aios_todos_v1: localStorage.getItem(TODO_KEY) || "[]",
      hq_order_v1: localStorage.getItem(ORDER_KEY) || "{}"
    };
  }
  function rerender() { if (typeof window.AIOS_RERENDER === "function") { try { window.AIOS_RERENDER(); } catch (e) {} } }

  /* ---- pull (JSONP GET) ---- */
  function pull() {
    if (!active()) return;
    var pw = getPW(), url = getURL();
    var cb = "aiosSync" + Math.floor(Math.random() * 1e9), s = document.createElement("script"), done = false;
    window[cb] = function (resp) {
      done = true;
      try {
        if (resp && resp.ok && resp.data) decryptB64(resp.data, pw).then(applyRemote).catch(function () {});
        else applyRemote(null);
      } finally { delete window[cb]; if (s.parentNode) s.remove(); }
    };
    s.onerror = function () { if (!done) { delete window[cb]; if (s.parentNode) s.remove(); } };
    s.src = url + (url.indexOf("?") < 0 ? "?" : "&") + "action=get&cb=" + cb + "&t=" + Date.now();
    document.body.appendChild(s);
  }

  function applyRemote(state) {
    var rkv = (state && state.kv) || {};
    var rChk = remoteLog(rkv, "aios_checks_log", "hq_checks_v1");
    var rDel = remoteLog(rkv, "aios_deleted_log", "hq_deleted_v1");
    var mChk = mergeLog(rChk, parseObj(localStorage.getItem(CHECK_LOG)));
    var mDel = mergeLog(rDel, parseObj(localStorage.getItem(DEL_LOG)));
    _set(CHECK_LOG, JSON.stringify(mChk));
    _set(DEL_LOG, JSON.stringify(mDel));

    var changed = false;
    function setIf(k, canonVal) { if (canonMap(localStorage.getItem(k)) !== canonVal) { _set(k, canonVal); changed = true; } }
    setIf(CHECK_KEY, JSON.stringify(logToMap(mChk)));
    setIf(DEL_KEY, JSON.stringify(logToMap(mDel)));

    var mergedTodos = mergeTodos(parseArr(rkv.aios_todos_v1), parseArr(localStorage.getItem(TODO_KEY)));
    if ((localStorage.getItem(TODO_KEY) || "[]") !== JSON.stringify(mergedTodos)) { _set(TODO_KEY, JSON.stringify(mergedTodos)); changed = true; }
    var ro = parseObj(rkv.hq_order_v1);
    if (ro && Object.keys(ro).length && (localStorage.getItem(ORDER_KEY) || "") !== JSON.stringify(ro)) { _set(ORDER_KEY, JSON.stringify(ro)); changed = true; }

    if (changed) rerender();

    var contributes =
      (canonLog(mChk) !== canonLog(rChk)) ||
      (canonLog(mDel) !== canonLog(rDel)) ||
      (mergedTodos.length !== parseArr(rkv.aios_todos_v1).length);
    if (contributes) pushNow();
  }

  /* ---- push: WRITE via GET (works on iPhone Safari too; POST's body is dropped through
          Google's redirect on Safari, which silently broke phone saves) ---- */
  var pushing = false, pushAgain = false;
  function pushNow() {
    if (!active()) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    var url = getURL(), pw = getPW();
    function finish() { pushing = false; if (pushAgain) { pushAgain = false; schedulePush(); } }
    encryptJSON({ ts: Date.now(), kv: gatherKV() }, pw).then(function (data) {
      var src = url + (url.indexOf("?") < 0 ? "?" : "&") + "action=set&t=" + Date.now() + "&data=" + encodeURIComponent(data);
      fetch(src, { mode: "no-cors" }).then(finish, finish);
    }).catch(finish);
  }

  /* ---- watch local changes ---- */
  var pushTimer = null;
  function schedulePush() { if (!active()) return; if (pushTimer) clearTimeout(pushTimer); pushTimer = setTimeout(function () { pushTimer = null; pushNow(); }, 800); }
  try {
    localStorage.setItem = function (k, v) {
      _set(k, v);
      if (k === CHECK_KEY) { recordToggles(CHECK_LOG, v); schedulePush(); }
      else if (k === DEL_KEY) { recordToggles(DEL_LOG, v); schedulePush(); }
      else if (k === TODO_KEY || k === ORDER_KEY) { schedulePush(); }
    };
  } catch (e) {}

  /* ---- the ☁ Sync button ---- */
  function refreshBtn() {
    var b = document.getElementById("sync-btn"); if (!b) return;
    var on = !!getURL();
    b.textContent = on ? "☁ Sync ✓" : "☁ Sync";
    b.classList.toggle("on", on);
    b.title = on ? "Cross-device sync is ON for this device. Tap to change or turn off." : "Turn on sync so your ticks + to-dos match on PC and iPhone.";
  }
  function setup() {
    var v = window.prompt("Paste your AIOS Sync link (ends with /exec).\nLeave blank + OK to turn sync OFF on this device.", getURL() || "");
    if (v === null) return;
    v = v.trim();
    if (!v) { try { localStorage.removeItem(URL_KEY); } catch (e) {} refreshBtn(); alert("Sync is now OFF on this device."); return; }
    if (!/^https:\/\/script\.google\.com\/.*\/exec/.test(v)) { if (!confirm("That doesn't look like a Google Apps Script /exec link.\nSave it anyway?")) return; }
    _set(URL_KEY, v); refreshBtn();
    if (!getPW()) alert("Sync link saved. ✓\n\nLast step: open 🧭 HQ, unlock it once with “Remember on this device” ticked. Do this on PC and iPhone.");
    else { alert("Sync is ON. ✓  Syncing now."); pull(); }
  }

  function start() {
    // seed logs from whatever is already ticked/deleted on this device (so existing state is represented)
    _set(CHECK_LOG, JSON.stringify(seedLog(parseObj(localStorage.getItem(CHECK_LOG)), localStorage.getItem(CHECK_KEY))));
    _set(DEL_LOG, JSON.stringify(seedLog(parseObj(localStorage.getItem(DEL_LOG)), localStorage.getItem(DEL_KEY))));
    refreshBtn();
    var b = document.getElementById("sync-btn"); if (b) b.addEventListener("click", setup);
    pull();
    setInterval(pull, 8000);
    window.addEventListener("focus", pull);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) pull(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
