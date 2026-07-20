// Finance Control — cloud auth bootstrap. Only the GitHub Pages build loads
// this file (the Mac's local server never serves it). Handles sign-in against
// Supabase Auth (emailed magic link or 6-digit code), keeps the session
// fresh, and rewrites the app's relative /api/* calls to the Supabase edge
// function with the user's token attached. The rest of the app is
// byte-identical to the local version.
(() => {
  const APIKEY = "sb_publishable_LYhST_J6cI42R8vxmNba1w_nKl3LNAZ";
  // The page is hosted on GitHub Pages; data and auth live in Supabase.
  const ORIGIN = "https://thizwrjygsrnofnrdnuu.supabase.co";
  const FN_ROOT = ORIGIN + "/functions/v1/app";
  const SKEY = "fc-cloud-session";

  let session = null;
  try { session = JSON.parse(localStorage.getItem(SKEY) || "null"); } catch {}

  // Magic-link landing: the emailed link redirects here with tokens in the
  // URL hash (#access_token=...&refresh_token=...). Adopt them as the session
  // and clean the URL before the app's hash-based router sees it.
  if (location.hash.includes("access_token=")) {
    try {
      const p = new URLSearchParams(location.hash.slice(1));
      if (p.get("access_token") && p.get("refresh_token")) {
        session = {
          access_token: p.get("access_token"),
          refresh_token: p.get("refresh_token"),
          expires_at: +(p.get("expires_at") || 0) || Math.floor(Date.now() / 1000) + (+(p.get("expires_in") || 3600)),
          email: "",
        };
        try {
          const payload = JSON.parse(atob(session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
          session.email = payload.email || "";
        } catch {}
        try { localStorage.setItem(SKEY, JSON.stringify(session)); } catch {}
        history.replaceState(null, "", location.pathname + location.search + "#dashboard");
      }
    } catch {}
  }

  const save = (s) => { session = s; try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch {} };
  const drop = () => { session = null; try { localStorage.removeItem(SKEY); } catch {} };
  const valid = () => !!(session && session.access_token && session.expires_at - 60 > Date.now() / 1000);

  const normalize = (d) => ({
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
    email: (d.user && d.user.email) || (session && session.email) || "",
  });

  async function authPost(path, body) {
    const res = await origFetch(ORIGIN + "/auth/v1" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: APIKEY },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, data };
  }

  async function refresh() {
    if (!session || !session.refresh_token) return false;
    const { ok, data } = await authPost("/token?grant_type=refresh_token", {
      refresh_token: session.refresh_token,
    });
    if (!ok || !data.access_token) return false;
    save(normalize(data));
    return true;
  }

  // ---- Login overlay (two steps: email -> 6-digit code) ----

  function overlayUI(resolve) {
    const el = document.createElement("div");
    el.id = "cloud-login";
    el.innerHTML = `
      <style>
        #cloud-login{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
          background:#0f1115;font-family:system-ui,-apple-system,sans-serif}
        #cloud-login .card{background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:32px 28px;
          width:min(92vw,360px);color:#e8eaf0;box-shadow:0 20px 60px rgba(0,0,0,.5)}
        #cloud-login h1{font-size:20px;margin:0 0 4px;display:flex;gap:8px;align-items:center}
        #cloud-login p{margin:6px 0 18px;color:#9aa3b2;font-size:13px;line-height:1.5}
        #cloud-login input{width:100%;box-sizing:border-box;background:#0f1115;border:1px solid #2a2f3a;color:#e8eaf0;
          border-radius:8px;padding:11px 12px;font-size:16px;margin-bottom:12px;outline:none}
        #cloud-login input:focus{border-color:#4f7cff}
        #cloud-login button{width:100%;background:#4f7cff;border:0;color:#fff;border-radius:8px;padding:11px;
          font-size:15px;font-weight:600;cursor:pointer}
        #cloud-login button:disabled{opacity:.55;cursor:default}
        #cloud-login .err{color:#ff7b72;font-size:13px;min-height:18px;margin:8px 0 0}
        #cloud-login .alt{background:none;color:#9aa3b2;font-weight:400;font-size:13px;margin-top:10px}
        #cloud-login .code-input{letter-spacing:8px;text-align:center;font-size:22px}
      </style>
      <div class="card">
        <h1>💵 Finance Control</h1>
        <p class="step-msg">Sign in with your email and password.</p>
        <div class="step step-pw">
          <input type="email" class="email" placeholder="you@example.com" autocomplete="email">
          <input type="password" class="pw" placeholder="password" autocomplete="current-password">
          <button class="signin">Sign in</button>
          <button class="alt back">Email me a sign-in link instead</button>
        </div>
        <div class="step step-code" hidden>
          <input inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="code code-input" placeholder="······">
          <button class="verify">Sign in with code</button>
          <button class="alt topw">← Use my password instead</button>
        </div>
        <div class="err"></div>
      </div>`;
    document.body.appendChild(el);
    const $ = (sel) => el.querySelector(sel);
    const err = (m) => { $(".err").textContent = m || ""; };
    const email = $(".email");
    email.value = localStorage.getItem("fc-cloud-email") || "";

    function finish(data) {
      localStorage.setItem("fc-cloud-email", email.value.trim().toLowerCase());
      save(normalize(data));
      el.remove();
      resolve();
    }

    async function signIn() {
      const addr = email.value.trim().toLowerCase();
      const pw = $(".pw").value;
      if (!addr) { err("Enter your email"); return; }
      if (!pw) { err("Enter your password"); return; }
      $(".signin").disabled = true; err("");
      const { ok, data } = await authPost("/token?grant_type=password", { email: addr, password: pw });
      $(".signin").disabled = false;
      if (!ok || !data.access_token) {
        const msg = (data.msg || data.error_description || data.message || "").toLowerCase();
        err(msg.includes("rate") || msg.includes("limit")
          ? "Too many attempts — wait a few minutes and try again."
          : "Wrong email or password.");
        return;
      }
      finish(data);
    }

    async function sendCode() {
      const addr = email.value.trim().toLowerCase();
      if (!addr) { err("Enter your email first"); return; }
      err("");
      const { ok, data } = await authPost("/otp", { email: addr, create_user: false });
      if (!ok) {
        const msg = (data.msg || data.error_description || data.message || "").toLowerCase();
        err(msg.includes("signup") ? "That email isn't set up for this app."
          : msg.includes("rate") || msg.includes("limit") ? "Too many codes requested — wait a few minutes and try again."
          : "Couldn't send the email. Try again in a minute.");
        return;
      }
      localStorage.setItem("fc-cloud-email", addr);
      $(".step-pw").hidden = true;
      $(".step-code").hidden = false;
      $(".step-msg").textContent =
        `We emailed ${addr}. Tap the sign-in link in that email — or if it shows a 6-digit code, enter it here.`;
      $(".code").focus();
    }

    async function verify() {
      const code = $(".code").value.trim();
      if (code.length < 6) { err("Enter the 6-digit code from the email"); return; }
      $(".verify").disabled = true; err("");
      const { ok, data } = await authPost("/verify", {
        type: "email", email: email.value.trim().toLowerCase(), token: code,
      });
      $(".verify").disabled = false;
      if (!ok || !data.access_token) { err("That code didn't work — check it or send a new one."); return; }
      finish(data);
    }

    $(".signin").addEventListener("click", signIn);
    $(".pw").addEventListener("keydown", (e) => e.key === "Enter" && signIn());
    email.addEventListener("keydown", (e) => e.key === "Enter" && ($(".pw").value ? signIn() : $(".pw").focus()));
    $(".back").addEventListener("click", sendCode);
    $(".verify").addEventListener("click", verify);
    $(".code").addEventListener("keydown", (e) => e.key === "Enter" && verify());
    $(".topw").addEventListener("click", () => {
      $(".step-code").hidden = true; $(".step-pw").hidden = false;
      $(".step-msg").textContent = "Sign in with your email and password."; err("");
    });
  }

  let pendingLogin = null;
  function ensureSession() {
    if (valid()) return Promise.resolve();
    if (!pendingLogin) {
      pendingLogin = (async () => {
        if (await refresh()) return;
        drop();
        await new Promise((resolve) => {
          const go = () => overlayUI(resolve);
          document.body ? go() : document.addEventListener("DOMContentLoaded", go);
        });
      })().finally(() => { pendingLogin = null; });
    }
    return pendingLogin;
  }

  // ---- Patch /api/* calls to hit the edge function with the token ----

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!url.startsWith("/api/")) return origFetch(input, init);
    await ensureSession();
    const doFetch = () => {
      const headers = new Headers((init && init.headers) || {});
      headers.set("Authorization", "Bearer " + session.access_token);
      headers.set("apikey", APIKEY);
      return origFetch(FN_ROOT + url, { ...(init || {}), headers });
    };
    let res = await doFetch();
    if (res.status === 401) {
      if (await refresh()) res = await doFetch();
      if (res.status === 401) { drop(); await ensureSession(); res = await doFetch(); }
    }
    return res;
  };

  const origBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
  navigator.sendBeacon = (url, data) => {
    if (typeof url === "string" && url.startsWith("/api/") && valid()) {
      origFetch(FN_ROOT + url, {
        method: "POST", body: data, keepalive: true,
        headers: { Authorization: "Bearer " + session.access_token, apikey: APIKEY },
      }).catch(() => {});
      return true;
    }
    return origBeacon ? origBeacon(url, data) : false;
  };

  // ---- Small "signed in as" footer with sign-out ----
  document.addEventListener("DOMContentLoaded", () => {
    const foot = document.querySelector(".sidebar-foot");
    if (!foot) return;
    const row = document.createElement("div");
    row.style.cssText = "font-size:11px;color:#9aa3b2;margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap";
    const who = document.createElement("span");
    const link = (text, onClick) => {
      const a = document.createElement("a");
      a.textContent = text;
      a.href = "#";
      a.style.cssText = "color:inherit;text-decoration:underline";
      a.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
      return a;
    };
    const out = link("Sign out", () => { drop(); location.reload(); });
    const chpw = link("Change password", async () => {
      if (!valid()) return;
      const pw = prompt("New password (at least 8 characters):");
      if (!pw) return;
      if (pw.length < 8) { alert("Use at least 8 characters."); return; }
      if (pw !== prompt("Type it once more to confirm:")) { alert("Those didn't match — password unchanged."); return; }
      const res = await origFetch(ORIGIN + "/auth/v1/user", {
        method: "PUT",
        headers: { "Content-Type": "application/json", apikey: APIKEY, Authorization: "Bearer " + session.access_token },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) alert("Password updated.");
      else {
        let msg = "";
        try { msg = (await res.json()).msg || ""; } catch {}
        alert("Couldn't change the password. " + msg);
      }
    });
    const update = () => { who.textContent = (session && session.email) ? session.email : ""; };
    update();
    setInterval(update, 3000);
    row.append(who, chpw, out);
    foot.appendChild(row);
  });
})();
