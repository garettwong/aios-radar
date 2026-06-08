/* AIOS Sync (client) — keeps your ticks + to-dos the same on PC and iPhone.
 *
 * - Your taps (ticks, to-dos, deletes, order) are ENCRYPTED with your HQ password
 *   and parked in your own free Google Apps Script store. Reads use JSONP GET,
 *   writes use POST. Google only ever sees gibberish.
 * - CONVERGENT MERGE (not "newest clock wins"): on every pull we UNION the cloud
 *   state with this device's, so a cross-off / new to-do made on EITHER device shows
 *   up everywhere and the two devices always settle on the same set. No clocks to
 *   drift, no stuck "one's ahead of the other".
 *   (Trade-off: UN-crossing / deleting a to-do may bounce back from the other device.
 *    Crossing-off and adding always sync. Un-do sync can be added later if needed.)
 *
 * Turn on: tap ☁ Sync, paste your Web App URL. Inert until configured.
 */
(function () {
  "use strict";
  var SYNC_KEYS = ["hq_checks_v1", "hq_deleted_v1", "hq_order_v1", "aios_todos_v1"];
  var URL_KEY = "aios_sync_url", PW_KEY = "hq_pw_v1";
  var _set = localStorage.setItem.bind(localStorage);   // raw setter, captured before we patch

  function getURL() { try { return localStorage.getItem(URL_KEY) || ""; } catch (e) { return ""; } }
  function getPW() { try { return localStorage.getItem(PW_KEY) || ""; } catch (e) { return ""; } }
  function active() { return !!getURL() && !!getPW() && !!(window.crypto && window.crypto.subtle); }

  /* ---- crypto: PBKDF2-SHA256(150k) -> AES-GCM-256; blob = base64(salt16|iv12|ct) ---- */
  function b64e(buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function b64d(str) { var s = atob(str), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  function deriveKey(pw, salt) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 150000, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
  }
  function encryptJSON(obj, pw) {
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(pw, salt).then(function (key) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    }).then(function (ct) {
      var out = new Uint8Array(28 + ct.byteLength); out.set(salt, 0); out.set(iv, 16); out.set(new Uint8Array(ct), 28);
      return b64e(out.buffer);
    });
  }
  function decryptB64(str, pw) {
    var raw = b64d(str), salt = raw.slice(0, 16), iv = raw.slice(16, 28), ct = raw.slice(28);
    return deriveKey(pw, salt).then(function (key) { return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct); })
      .then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }

  /* ---- merge helpers ---- */
  function parseObj(s) { try { var o = JSON.parse(s || "{}"); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; } }
  function parseArr(s) { try { var a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function canon(mapStr) { var o = parseObj(mapStr), s = {}; Object.keys(o).sort().forEach(function (k) { s[k] = o[k]; }); return JSON.stringify(s); }
  function unionMap(a, b) { return canon(JSON.stringify(Object.assign({}, parseObj(a), parseObj(b)))); }
  function mergeTodos(a, b) {
    var map = {}, seen = {}, out = [];
    (a || []).forEach(function (t) { if (t && t.id != null) map[t.id] = t; });
    (b || []).forEach(function (t) { if (t && t.id != null && !(t.id in map)) map[t.id] = t; });
    (a || []).concat(b || []).forEach(function (t) { if (t && t.id != null && !seen[t.id]) { seen[t.id] = 1; out.push(map[t.id]); } });
    return out;
  }
  // union of cloud state + this device's state (canonical, so equal sets compare equal)
  function unionState(rkv) {
    var ro = parseObj(rkv["hq_order_v1"]);
    return {
      "hq_checks_v1": unionMap(rkv["hq_checks_v1"], localStorage.getItem("hq_checks_v1")),
      "hq_deleted_v1": unionMap(rkv["hq_deleted_v1"], localStorage.getItem("hq_deleted_v1")),
      "aios_todos_v1": JSON.stringify(mergeTodos(parseArr(rkv["aios_todos_v1"]), parseArr(localStorage.getItem("aios_todos_v1")))),
      "hq_order_v1": (ro && Object.keys(ro).length) ? JSON.stringify(ro) : (localStorage.getItem("hq_order_v1") || "{}")
    };
  }

  function gatherKV() { var kv = {}; SYNC_KEYS.forEach(function (k) { var v = localStorage.getItem(k); if (v !== null) kv[k] = v; }); return kv; }
  function rerender() { if (typeof window.AIOS_RERENDER === "function") { try { window.AIOS_RERENDER(); } catch (e) {} } }

  /* ---- pull (JSONP GET) ---- */
  function pull() {
    if (!active()) return;
    var pw = getPW(), url = getURL();
    var cb = "aiosSync" + Math.floor(Math.random() * 1e9), s = document.createElement("script"), done = false;
    window[cb] = function (resp) {
      done = true;
      try {
        if (resp && resp.ok && resp.data) {
          decryptB64(resp.data, pw).then(applyRemote).catch(function () { /* can't read store (transient/foreign) — don't clobber */ });
        } else {
          applyRemote(null);   // empty store -> publish this device's state
        }
      } finally { delete window[cb]; if (s.parentNode) s.remove(); }
    };
    s.onerror = function () { if (!done) { delete window[cb]; if (s.parentNode) s.remove(); } };
    s.src = url + (url.indexOf("?") < 0 ? "?" : "&") + "action=get&cb=" + cb + "&t=" + Date.now();
    document.body.appendChild(s);
  }

  // union cloud + local; show the union here; if we have anything the cloud lacks, push the union up
  function applyRemote(state) {
    var rkv = (state && state.kv) || {};
    var merged = unionState(rkv);
    var changed = false;
    SYNC_KEYS.forEach(function (k) { if (merged[k] !== localStorage.getItem(k)) { _set(k, merged[k]); changed = true; } });
    if (changed) rerender();
    var contributes =
      (merged["hq_checks_v1"] !== canon(rkv["hq_checks_v1"] || "{}")) ||
      (merged["hq_deleted_v1"] !== canon(rkv["hq_deleted_v1"] || "{}")) ||
      (parseArr(merged["aios_todos_v1"]).length !== parseArr(rkv["aios_todos_v1"]).length);
    if (contributes) pushNow();
  }

  /* ---- push (POST; encrypted, any size) ---- */
  var pushing = false, pushAgain = false;
  function pushNow() {
    if (!active()) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    var url = getURL(), pw = getPW();
    function finish() { pushing = false; if (pushAgain) { pushAgain = false; schedulePush(); } }
    encryptJSON({ ts: Date.now(), kv: gatherKV() }, pw).then(function (data) {
      fetch(url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "set", data: data }) }).then(finish, finish);
    }).catch(finish);
  }

  /* ---- detect local changes by patching setItem for our keys ---- */
  var pushTimer = null;
  function schedulePush() { if (!active()) return; if (pushTimer) clearTimeout(pushTimer); pushTimer = setTimeout(function () { pushTimer = null; pushNow(); }, 1000); }
  try { localStorage.setItem = function (k, v) { _set(k, v); if (SYNC_KEYS.indexOf(k) >= 0) schedulePush(); }; } catch (e) {}

  /* ---- the ☁ Sync button ---- */
  function refreshBtn() {
    var b = document.getElementById("sync-btn"); if (!b) return;
    var on = !!getURL();
    b.textContent = on ? "☁ Sync ✓" : "☁ Sync";
    b.classList.toggle("on", on);
    b.title = on ? "Cross-device sync is ON for this device. Tap to change or turn off."
                 : "Turn on sync so your ticks + to-dos match on PC and iPhone.";
  }
  function setup() {
    var cur = getURL();
    var v = window.prompt("Paste your AIOS Sync link (ends with /exec).\nLeave blank + OK to turn sync OFF on this device.", cur || "");
    if (v === null) return;
    v = v.trim();
    if (!v) { try { localStorage.removeItem(URL_KEY); } catch (e) {} refreshBtn(); alert("Sync is now OFF on this device."); return; }
    if (!/^https:\/\/script\.google\.com\/.*\/exec/.test(v)) {
      if (!confirm("That doesn't look like a Google Apps Script /exec link.\nSave it anyway?")) return;
    }
    _set(URL_KEY, v);
    refreshBtn();
    if (!getPW()) {
      alert("Sync link saved. ✓\n\nLast step: open 🧭 HQ, unlock it once with “Remember on this device” ticked, so sync can use your password. Do this on PC and iPhone.");
    } else {
      alert("Sync is ON. ✓  Syncing now — your ticks + to-dos will match across devices within a few seconds.");
      pull();
    }
  }

  function start() {
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
