/* HQ cockpit unlock — decrypts window.DASHBOARD_HQ_ENC with your password (WebCrypto AES-GCM).
   On the public site the cockpit ships as real ciphertext; without the password it is unreadable. */
(function () {
  "use strict";
  var PW_KEY = "hq_pw_v1";

  function b64(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

  async function decrypt(blob, password) {
    var enc = new TextEncoder();
    var base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    var key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64(blob.salt), iterations: blob.iter || 150000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(blob.iv) }, key, b64(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  function shell(inner) { return '<div class="hq-lock-card">' + inner + "</div>"; }

  function renderLock(host, onUnlock) {
    var blob = window.DASHBOARD_HQ_ENC;
    if (!blob || blob.setup === false || blob.v === 0) {
      host.innerHTML = shell(
        '<div class="hq-lock-ico">🔒</div>' +
        '<div class="hq-lock-title">Cockpit not set up yet</div>' +
        '<div class="hq-lock-sub">On your PC, run <code>tools\\set-hq-password.ps1</code> to choose a password. Your private data is encrypted before it ever reaches this page.</div>');
      return;
    }
    host.innerHTML = shell(
      '<div class="hq-lock-ico">🔒</div>' +
      '<div class="hq-lock-title">Your cockpit is locked</div>' +
      '<div class="hq-lock-sub">Enter your password to unlock today’s plan, money &amp; wishlist.</div>' +
      '<input id="hq-pw" type="password" class="hq-lock-input" placeholder="password" autocomplete="current-password" />' +
      '<label class="hq-lock-remember"><input id="hq-pw-remember" type="checkbox" checked /> Remember on this device</label>' +
      '<button id="hq-pw-go" class="hq-lock-btn" type="button">Unlock</button>' +
      '<div id="hq-pw-msg" class="hq-lock-msg"></div>');
    var input = host.querySelector("#hq-pw"), btn = host.querySelector("#hq-pw-go"),
        msg = host.querySelector("#hq-pw-msg"), rem = host.querySelector("#hq-pw-remember");

    async function tryPw(pw, fromCache) {
      if (!pw) { msg.textContent = "Type your password."; return; }
      btn.disabled = true; msg.textContent = "Unlocking…";
      try {
        var obj = await decrypt(blob, pw);
        if (rem && rem.checked) { try { localStorage.setItem(PW_KEY, pw); } catch (e) {} }
        onUnlock(obj);
      } catch (e) {
        btn.disabled = false;
        msg.textContent = fromCache ? "Saved password no longer works — type it again." : "Wrong password.";
        try { localStorage.removeItem(PW_KEY); } catch (e2) {}
        if (input) { input.value = ""; input.focus(); }
      }
    }

    btn.addEventListener("click", function () { tryPw(input.value, false); });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") tryPw(input.value, false); });
    setTimeout(function () { if (input) input.focus(); }, 50);

    var cached = null; try { cached = localStorage.getItem(PW_KEY); } catch (e) {}
    if (cached) { if (rem) rem.checked = true; tryPw(cached, true); }
  }

  window.HQ_UNLOCK = { renderLock: renderLock, decrypt: decrypt, forget: function () { try { localStorage.removeItem(PW_KEY); } catch (e) {} } };
})();
