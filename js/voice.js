// Voice control: navigation + create / update / delete / pay by speech.
// Uses the browser's Web Speech API (SpeechRecognition + speechSynthesis).

import {
  getState, mutate, activeBills, payBill, ACCOUNT_TYPES, billCategories,
  VALUED_TYPES, syncValuedBalance,
} from "./store.js";
import { render, toast, openModal, closeModal } from "./app.js";
import { billForm } from "./views/bills.js";
import { accountForm, incomeForm, budgetItemForm } from "./views/accounts.js";
import {
  FREQUENCIES, todayStr, addDays, toYMD, parseYMD, fmtDate, fmtMoney,
} from "./utils.js";

let recog = null;
let listening = false;
let restartOnEnd = false;
let pendingConfirm = null; // {say, fn}
let hud, micBtn, hudText, hudState;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// ---------------- UI ----------------

export function initVoice() {
  const wrap = document.createElement("div");
  wrap.id = "voice-root";
  wrap.innerHTML = `
    <div class="voice-hud" id="voice-hud" hidden>
      <div class="voice-hud-state" id="voice-hud-state">Listening…</div>
      <div class="voice-hud-text" id="voice-hud-text">Say a command — or "help"</div>
    </div>
    <button class="mic-btn" id="mic-btn" title='Voice control — click or press "V" (say "help" for commands)' aria-label="Toggle voice control">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>
        <path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
        <line x1="12" y1="18" x2="12" y2="22"></line>
      </svg>
    </button>`;
  document.body.appendChild(wrap);
  hud = document.getElementById("voice-hud");
  hudText = document.getElementById("voice-hud-text");
  hudState = document.getElementById("voice-hud-state");
  micBtn = document.getElementById("mic-btn");

  micBtn.addEventListener("click", toggle);
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "v" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    toggle();
  });

  if (!SR) {
    micBtn.classList.add("mic-unavailable");
    micBtn.title = "Voice control isn't supported in this browser (try Chrome, Edge, or Safari)";
  }

  // Test/debug hook: lets a command be run without a microphone.
  window.__voiceCommand = (t) => handleCommand(String(t));
}

function toggle() {
  if (!SR) { toast("Voice control isn't supported in this browser"); return; }
  listening ? stopListening() : startListening();
}

function startListening() {
  recog = new SR();
  recog.lang = "en-US";
  recog.continuous = true;
  recog.interimResults = true;

  recog.onresult = (ev) => {
    let interim = "", finals = [];
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finals.push(r[0].transcript);
      else interim += r[0].transcript;
    }
    if (interim) hudText.textContent = interim;
    for (const f of finals) handleCommand(f);
  };
  recog.onerror = (ev) => {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      stopListening();
      feedback("Microphone access was blocked — allow it in the browser and try again.", { speak: false });
      toast("Microphone access blocked");
    }
  };
  recog.onend = () => { if (restartOnEnd) { try { recog.start(); } catch {} } };

  try { recog.start(); } catch { return; }
  listening = true;
  restartOnEnd = true;
  micBtn.classList.add("mic-on");
  hud.hidden = false;
  hudState.textContent = "Listening…";
  hudText.textContent = 'Say a command — or "help"';
}

function stopListening() {
  restartOnEnd = false;
  listening = false;
  if (recog) { try { recog.stop(); } catch {} }
  micBtn.classList.remove("mic-on");
  hud.hidden = true;
  pendingConfirm = null;
  window.speechSynthesis?.cancel();
}

function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

function feedback(msg, { speak: doSpeak = true } = {}) {
  if (hud && !hud.hidden) hudText.textContent = msg;
  if (doSpeak && listening) speak(msg);
}

// ---------------- Parsing helpers ----------------

const norm = (s) => s.toLowerCase().replace(/[.,!?]+$/g, "").replace(/\s+/g, " ").trim();

const parseAmount = (s) => {
  const m = String(s).replace(/,/g, "").match(/-?\$?\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
};

const FREQ_WORDS = [
  [/\bevery ?(?:2|two) weeks?\b|\bbi-?weekly\b|\bfortnightly\b/, "biweekly"],
  [/\btwice a month\b|\bsemi-?monthly\b/, "semimonthly"],
  [/\bevery ?(?:3|three) months?\b|\bquarterly\b/, "quarterly"],
  [/\bevery ?(?:6|six) months?\b|\bsemi-?annual(?:ly)?\b|\btwice a year\b/, "semiannual"],
  [/\byearly\b|\bannual(?:ly)?\b|\bevery year\b|\bper year\b|\bonce a year\b/, "annual"],
  [/\bweekly\b|\bevery week\b|\bper week\b|\bonce a week\b/, "weekly"],
  [/\bmonthly\b|\bevery month\b|\bper month\b|\bonce a month\b/, "monthly"],
  [/\bone[- ]?time\b|\bonce\b/, "once"],
];
const parseFrequency = (s) => {
  for (const [re, id] of FREQ_WORDS) if (re.test(s)) return { id, match: s.match(re)[0] };
  return null;
};

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

function parseSpokenDate(s) {
  s = norm(s).replace(/^(?:on |the )+/, "");
  const today = todayStr();
  if (/^today$/.test(s)) return today;
  if (/^tomorrow$/.test(s)) return addDays(today, 1);
  let m = s.match(/^in (\d+) days?$/);
  if (m) return addDays(today, +m[1]);
  m = s.match(/^next week$/);
  if (m) return addDays(today, 7);
  m = s.match(/^(\w+) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/); // "july 25" / "july 25 2026"
  if (m) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[1]));
    if (mi >= 0) {
      const now = parseYMD(today);
      let y = m[3] ? +m[3] : now.getFullYear();
      let d = new Date(y, mi, +m[2]);
      if (!m[3] && toYMD(d) < today) d = new Date(y + 1, mi, +m[2]);
      return toYMD(d);
    }
  }
  m = s.match(/^(?:the )?(\d{1,2})(?:st|nd|rd|th)?(?: of (?:the |this |next )?month)?$/); // "the 15th"
  if (m) {
    const day = +m[1];
    if (day >= 1 && day <= 31) {
      const now = parseYMD(today);
      let d = new Date(now.getFullYear(), now.getMonth(), Math.min(day, 28) === day ? day : day);
      if (toYMD(d) < today) d = new Date(now.getFullYear(), now.getMonth() + 1, day);
      return toYMD(d);
    }
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  return null;
}

const parseBool = (s) => /\b(on|yes|true|enable|enabled)\b/.test(s) ? true : /\b(off|no|false|disable|disabled)\b/.test(s) ? false : null;

// ---------------- Entity lookup ----------------

function allEntities() {
  const s = getState();
  return [
    ...s.bills.filter((b) => b.active !== false).map((o) => ({ type: "bill", obj: o })),
    ...s.accounts.map((o) => ({ type: "account", obj: o })),
    ...s.incomes.map((o) => ({ type: "income", obj: o })),
    ...s.budgetItems.map((o) => ({ type: "budget", obj: o })),
  ];
}

function findEntity(name, typeHint) {
  const q = norm(name);
  if (!q) return null;
  let pool = allEntities();
  if (typeHint) {
    const types = Array.isArray(typeHint) ? typeHint : [typeHint];
    pool = pool.filter((e) => types.includes(e.type));
  }
  let best = null, bestScore = 0;
  for (const e of pool) {
    const n = norm(e.obj.name || "");
    if (!n) continue;
    let score = 0;
    if (n === q) score = 100;
    else if (n.includes(q) || q.includes(n)) score = 60 + Math.min(n.length, q.length);
    else {
      const qw = q.split(" "), nw = n.split(" ");
      const hits = qw.filter((w) => nw.some((x) => x.startsWith(w))).length;
      if (hits) score = 20 + hits * 10;
    }
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 30 ? best : null;
}

const TYPE_WORDS = [
  [/\b(?:bill|payment)\b/, "bill"],
  [/\b(?:account|card|loan|checking|savings|investment|insurance|business equity)\b/, "account"],
  [/\b(?:income|paycheck|salary|pay check)\b/, "income"],
  [/\b(?:spending(?: category)?|budget(?: item| category)?|category)\b/, "budget"],
];
const typeFromWords = (s) => { for (const [re, t] of TYPE_WORDS) if (re.test(s)) return t; return null; };

// ---------------- Command handling ----------------

const PAGES = [
  { hash: "dashboard", words: ["dashboard", "home", "overview"] },
  { hash: "bills", words: ["bills", "bill list", "my bills"] },
  { hash: "calendar", words: ["calendar", "month view", "schedule"] },
  { hash: "accounts", words: ["accounts", "accounts and income"] },
  { hash: "budget", words: ["budget", "forecast", "budget and forecast"] },
  { hash: "networth", words: ["net worth", "networth", "worth"] },
  { hash: "payoff", words: ["debt payoff", "payoff", "pay off", "debts", "debt plan"] },
  { hash: "cards", words: ["card paydown", "paydown", "pay down", "credit cards", "card usage", "utilization"] },
  { hash: "import", words: ["import", "import statement", "upload", "statement"] },
];

export function handleCommand(raw) {
  const t = norm(raw);
  if (!t) return;
  hudText.textContent = `"${raw.trim()}"`;

  // 0. confirmation gate
  if (pendingConfirm) {
    if (/^(confirm|yes|yes confirm|do it|go ahead)$/.test(t)) {
      const fn = pendingConfirm.fn;
      pendingConfirm = null;
      fn();
      return;
    }
    if (/^(cancel|no|never mind|nevermind|stop)$/.test(t)) {
      pendingConfirm = null;
      feedback("Cancelled.");
      return;
    }
    feedback(`Say "confirm" to ${pendingConfirm.say}, or "cancel".`);
    return;
  }

  // 1. meta
  if (/^(stop|stop listening|turn off|goodbye|good bye)$/.test(t)) { stopListening(); toast("Voice control off"); return; }
  if (/^(help|what can i say|commands|voice help)$/.test(t)) { showHelp(); feedback("Here's what you can say.", { speak: true }); return; }

  // 2. modal-scoped commands
  const modalForm = document.querySelector("#modal-root .modal form");
  if (modalForm) { handleModalCommand(t, modalForm); return; }

  // 3. navigation
  for (const p of PAGES) {
    for (const w of p.words) {
      if (t === w || t === `go to ${w}` || t === `open ${w}` || t === `show ${w}` || t === `show me ${w}` ||
          t === `switch to ${w}` || t === `navigate to ${w}` || t === `go to the ${w}` || t === `open the ${w}` ||
          t === `${w} page` || t === `go to ${w} page` || t === `open ${w} page` || t === `show ${w} page`) {
        location.hash = p.hash;
        feedback(`Opening ${p.words[0]}.`);
        return;
      }
    }
  }

  // 3b. calendar month navigation
  const cm = t.match(/^(?:go to |show )?(next|previous|last) month$/);
  if (cm) {
    import("./views/calendar.js").then(({ shiftCalendarMonth }) => {
      shiftCalendarMonth(cm[1] === "next" ? 1 : -1);
      location.hash = "calendar";
      render();
      feedback(cm[1] === "next" ? "Next month." : "Previous month.");
    });
    return;
  }
  if (/^this month$/.test(t)) {
    import("./views/calendar.js").then(({ resetCalendarMonth }) => {
      resetCalendarMonth();
      location.hash = "calendar";
      render();
      feedback("Back to this month.");
    });
    return;
  }

  // 4. export backup
  if (/^(export|download) (a )?backup$|^backup my data$/.test(t)) {
    document.getElementById("btn-export").click();
    feedback("Backup downloaded.");
    return;
  }

  // 5. mark paid  — "pay rent", "mark rent paid", "mark rent as paid", "record payment for rent", "i paid rent"
  let m = t.match(/^(?:mark )?(.+?) (?:as )?paid$/) || t.match(/^pay (?:the )?(.+)$/) ||
          t.match(/^record (?:a )?payment for (?:the )?(.+)$/) || t.match(/^i paid (?:the )?(.+)$/);
  if (m) {
    const hit = findEntity(m[1].replace(/\b(?:bill|the)\b/g, "").trim(), "bill");
    if (hit) {
      payBill(hit.obj, {});
      const b = getState().bills.find((x) => x.id === hit.obj.id);
      render();
      feedback(`Recorded ${fmtMoney(+hit.obj.amount)} payment for ${hit.obj.name}. Next due ${b && b.active !== false ? fmtDate(b.nextDue) : "— that was the last one"}.`);
    } else feedback(`I couldn't find a bill called "${m[1]}".`);
    return;
  }

  // 6. delete — with voice confirmation
  m = t.match(/^(?:delete|remove) (?:the |my )?(.+)$/);
  if (m) {
    let rest = m[1];
    const typeHint = typeFromWords(rest);
    if (typeHint) rest = rest.replace(TYPE_WORDS.find(([re]) => re.test(rest))[0], "").trim();
    const hit = findEntity(rest, typeHint);
    if (!hit) { feedback(`I couldn't find "${rest}" to delete.`); return; }
    const label = { bill: "bill", account: "account", income: "income", budget: "spending category" }[hit.type];
    pendingConfirm = {
      say: `delete the ${label} ${hit.obj.name}`,
      fn: () => {
        mutate((s) => {
          if (hit.type === "bill") s.bills = s.bills.filter((x) => x.id !== hit.obj.id);
          if (hit.type === "account") {
            s.accounts = s.accounts.filter((x) => x.id !== hit.obj.id);
            if (s.settings.checkingAccountId === hit.obj.id) s.settings.checkingAccountId = null;
            s.bills.forEach((b) => { if (b.linkedAccountId === hit.obj.id) b.linkedAccountId = ""; });
          }
          if (hit.type === "income") s.incomes = s.incomes.filter((x) => x.id !== hit.obj.id);
          if (hit.type === "budget") s.budgetItems = s.budgetItems.filter((x) => x.id !== hit.obj.id);
        });
        render();
        feedback(`Deleted ${hit.obj.name}.`);
        toast(`Deleted ${hit.obj.name}`);
      },
    };
    feedback(`Delete the ${label} "${hit.obj.name}"? Say "confirm" or "cancel".`);
    return;
  }

  // 7. rename
  m = t.match(/^rename (?:the )?(.+?) to (.+)$/);
  if (m) {
    const hit = findEntity(m[1], typeFromWords(m[1]));
    if (hit) {
      const newName = titleWords(m[2]);
      mutate(() => { hit.obj.name = newName; });
      render();
      feedback(`Renamed to ${newName}.`);
    } else feedback(`I couldn't find "${m[1]}".`);
    return;
  }

  // 8. autopay toggles — "turn on autopay for rent"
  m = t.match(/^turn (on|off) autopay (?:for |on )?(?:the )?(.+)$/) || t.match(/^(?:set |put )?(.+?) on autopay$/);
  if (m) {
    const on = m.length === 3 ? m[1] === "on" : true;
    const name = m.length === 3 ? m[2] : m[1];
    const hit = findEntity(name, "bill");
    if (hit) {
      mutate(() => { hit.obj.autopay = on; });
      render();
      feedback(`Autopay ${on ? "on" : "off"} for ${hit.obj.name}.`);
    } else feedback(`I couldn't find a bill called "${name}".`);
    return;
  }

  // 9. update a field — "change rent amount to 1500", "set visa balance to 4000"
  m = matchUpdate(t);
  if (m) { applyUpdate(m); return; }

  // 10. create — "add bill rent 1450 monthly due on the 31st"
  m = t.match(/^(?:add|create|new)(?: a| an)? (.+)$/);
  if (m) { handleCreate(m[1]); return; }

  feedback(`I didn't catch a command in "${raw.trim()}". Say "help" for what I understand.`);
}

const titleWords = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// ---- update grammar ----

const FIELD_DEFS = [
  // spoken name(s) → per-type property
  { re: /due date|next due|due/, prop: { bill: "nextDue" }, kind: "date" },
  { re: /payday|next payday|pay date/, prop: { income: "nextDate" }, kind: "date" },
  { re: /interest rate|interest|apr|rate/, prop: { account: "apr" }, kind: "number" },
  { re: /minimum payment|min payment|minimum/, prop: { account: "minPayment" }, kind: "number" },
  { re: /credit limit|limit/, prop: { account: "creditLimit" }, kind: "number" },
  { re: /principal balance|principal/, prop: { account: "principalBalance" }, kind: "number" },
  { re: /estimated value|value/, prop: { account: "estValue" }, kind: "number" },
  { re: /balance/, prop: { account: "balance" }, kind: "number" },
  { re: /amount|cost|price/, prop: { bill: "amount", income: "amount", budget: "amountPerMonth" }, kind: "number" },
  { re: /category/, prop: { bill: "category" }, kind: "category" },
  { re: /frequency|schedule/, prop: { bill: "frequency", income: "frequency" }, kind: "frequency" },
  { re: /autopay/, prop: { bill: "autopay" }, kind: "bool" },
  { re: /notes?/, prop: { bill: "notes", account: "notes" }, kind: "text" },
  { re: /name/, prop: { bill: "name", account: "name", income: "name", budget: "name" }, kind: "name" },
];
const FIELD_ALT = "due date|next due|due|payday|next payday|pay date|interest rate|interest|apr|rate|minimum payment|min payment|minimum|credit limit|limit|principal balance|principal|estimated value|value|balance|amount|cost|price|category|frequency|schedule|autopay|notes?|name";

function matchUpdate(t) {
  const re = new RegExp(`^(?:update|change|set|edit) (?:the |my )?(.+?)(?:'s)? (${FIELD_ALT}) (?:to |as |= ?)?(.+)$`);
  const m = t.match(re);
  if (!m) return null;
  return { name: m[1], fieldWord: m[2], value: m[3] };
}

function applyUpdate({ name, fieldWord, value }) {
  let rest = name;
  let typeHint = typeFromWords(rest);
  if (typeHint) rest = rest.replace(TYPE_WORDS.find(([re]) => re.test(rest))[0], "").trim() || rest;
  if (!typeHint) {
    // no explicit type spoken — only search entity types that actually have this field
    const allowed = [...new Set(FIELD_DEFS.filter((d) => d.re.test(fieldWord)).flatMap((d) => Object.keys(d.prop)))];
    if (allowed.length) typeHint = allowed;
  }
  const hit = findEntity(rest, typeHint);
  if (!hit) { feedback(`I couldn't find "${rest}".`); return; }

  const def = FIELD_DEFS.find((d) => d.re.test(fieldWord) && d.prop[hit.type]);
  if (!def) { feedback(`"${fieldWord}" isn't a field I can change on ${hit.obj.name}.`); return; }
  const prop = def.prop[hit.type];

  let v = null, spokenValue = "";
  switch (def.kind) {
    case "number":
      v = parseAmount(value);
      if (v == null) { feedback(`I didn't hear a number in "${value}".`); return; }
      spokenValue = def.re.source.includes("interest") || fieldWord.includes("rate") || fieldWord === "apr" ? `${v} percent` : fmtMoney(v);
      break;
    case "date":
      v = parseSpokenDate(value);
      if (!v) { feedback(`I couldn't understand the date "${value}". Try "the 15th" or "August 3rd".`); return; }
      spokenValue = fmtDate(v);
      break;
    case "frequency": {
      const f = parseFrequency(value);
      if (!f) { feedback(`I couldn't understand the schedule "${value}".`); return; }
      v = f.id; spokenValue = FREQUENCIES.find((x) => x.id === v).label.toLowerCase();
      break;
    }
    case "category": {
      const q = norm(value);
      v = billCategories().find((c) => norm(c).includes(q) || q.includes(norm(c)));
      if (!v) { feedback(`I don't have a category like "${value}".`); return; }
      spokenValue = v;
      break;
    }
    case "bool":
      v = parseBool(value);
      if (v == null) { feedback(`Say autopay on or off.`); return; }
      spokenValue = v ? "on" : "off";
      break;
    case "name":
      v = titleWords(value); spokenValue = v;
      break;
    default:
      v = value; spokenValue = value;
  }

  mutate(() => {
    hit.obj[prop] = v;
    // Valued assets: a spoken "balance" means the estimated value, and the
    // stored balance is always re-derived as value − principal.
    if (hit.type === "account" && VALUED_TYPES.includes(hit.obj.type)) {
      if (prop === "balance") hit.obj.estValue = v;
      syncValuedBalance(hit.obj);
    }
  });
  render();
  feedback(`${hit.obj.name}: ${fieldWord} is now ${spokenValue}.`);
  toast(`${hit.obj.name} updated`);
}

// ---- create grammar ----

function handleCreate(rest) {
  const type = typeFromWords(rest) || "bill";
  let text = rest;
  const typeMatch = TYPE_WORDS.find(([re]) => re.test(text));
  if (typeMatch) text = text.replace(typeMatch[0], " ").replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:called |named |for )/, "");

  // pull out parts
  let due = null;
  const dueM = text.match(/\b(?:due|starting|next)(?: on| date)?(?: the)? (.+)$/);
  if (dueM) {
    due = parseSpokenDate(dueM[1]);
    if (due) text = text.slice(0, dueM.index).trim();
  }
  const freq = parseFrequency(text);
  if (freq) text = text.replace(freq.match, " ").replace(/\s+/g, " ").trim();

  let apr = null;
  const aprM = text.match(/\b(?:at |with )?(?:interest(?: rate)?|apr)(?: of)? (\d+(?:\.\d+)?)\s*(?:%|percent)?/) ||
               text.match(/\b(\d+(?:\.\d+)?)\s*(?:%|percent) (?:interest|apr)/);
  if (aprM) { apr = parseFloat(aprM[1]); text = text.replace(aprM[0], " ").replace(/\s+/g, " ").trim(); }

  let amount = null;
  const amtM = text.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (amtM) {
    amount = parseFloat(amtM[1]);
    text = text.replace(/,/g, "").replace(amtM[0], " ").replace(/\b(?:for|of|dollars?|bucks)\b/g, " ").replace(/\s+/g, " ").trim();
  }

  const acctType = /credit card|credit|visa|mastercard|amex/.test(rest) ? "credit"
    : /loan|mortgage/.test(rest) ? "loan"
    : /savings/.test(rest) ? "savings"
    : /investment|401k|brokerage/.test(rest) ? "investment"
    : /life insurance|insurance/.test(rest) ? "lifeins"
    : /business/.test(rest) ? "business"
    : /personal property|valuables|jewelry|car\b|truck|boat/.test(rest) && type === "account" ? "personal"
    : /property|house|real estate/.test(rest) && type === "account" ? "property"
    : "checking";

  const name = titleWords(text.replace(/\b(?:a|an|the|new)\b/g, " ").replace(/\s+/g, " ").trim());

  const say = (what) => feedback(`${what} — check the details, then say "save", or change a field like "amount 25".`);

  if (type === "bill") {
    billForm({ name, amount, frequency: freq?.id || "monthly", nextDue: due || todayStr() });
    say(`New bill${name ? " " + name : ""}${amount ? ", " + fmtMoney(amount) : ""}`);
  } else if (type === "account") {
    accountForm({ name, type: acctType, balance: amount, apr });
    say(`New ${ACCOUNT_TYPES.find((x) => x.id === acctType).label.toLowerCase()} account${name ? " " + name : ""}`);
  } else if (type === "income") {
    incomeForm({ name: name || "Paycheck", amount, frequency: freq?.id || "biweekly", nextDate: due || todayStr() });
    say(`New income${name ? " " + name : ""}${amount ? ", " + fmtMoney(amount) : ""}`);
  } else if (type === "budget") {
    budgetItemForm({ name, amountPerMonth: amount }, render);
    say(`New spending category${name ? " " + name : ""}`);
  }
}

// ---- modal-scoped commands: fill fields, save, cancel ----

function handleModalCommand(t, form) {
  if (/^(save|save it|submit|done|confirm|yes save)$/.test(t)) {
    if (form.reportValidity()) { form.requestSubmit(); feedback("Saved."); }
    else feedback("Something's missing — fill the highlighted field or say cancel.");
    return;
  }
  if (/^(cancel|close|never mind|nevermind|discard)$/.test(t)) {
    closeModal();
    feedback("Closed without saving.");
    return;
  }
  if (/^(delete|delete this|remove this)$/.test(t)) {
    feedback('To delete by voice, close this form and say for example "delete bill rent".');
    return;
  }

  // Build label → input map from the open form
  const fields = [];
  form.querySelectorAll("label.field").forEach((lab) => {
    const span = lab.querySelector("span");
    const input = lab.querySelector("input, select");
    if (!span || !input) return;
    const label = norm(span.textContent.replace(/\(.*?\)/g, ""));
    fields.push({ label, input });
  });

  // try "set FIELD to VALUE" / "FIELD VALUE" with longest label match first
  const cleaned = t.replace(/^(?:set |change |make )/, "");
  let best = null;
  for (const f of fields) {
    const words = f.label.split(" ");
    for (let n = words.length; n >= 1; n--) {
      const prefix = words.slice(0, n).join(" ");
      if (prefix.length < 3) continue;
      if (cleaned.startsWith(prefix + " ") || cleaned === prefix) {
        if (!best || prefix.length > best.prefix.length) best = { f, prefix };
      }
    }
    // also match on a keyword inside the label, e.g. "due" for "next due date"
    const kw = cleaned.split(" ")[0];
    if (!best && kw.length >= 3 && f.label.includes(kw)) best = { f, prefix: kw };
  }
  if (!best) {
    feedback(`Say a field and value — like "amount 1500" or "due date August 1st" — then "save".`);
    return;
  }

  const { f, prefix } = best;
  const valueStr = cleaned.slice(prefix.length).replace(/^(?:to |as |is |= ?)/, "").trim();
  const input = f.input;

  if (input.type === "checkbox") {
    const b = parseBool(valueStr || "on");
    if (b == null) { feedback("Say on or off."); return; }
    input.checked = b;
    feedback(`${f.label}: ${b ? "on" : "off"}.`);
    return;
  }
  if (!valueStr) { feedback(`What should ${f.label} be?`); return; }

  if (input.tagName === "SELECT") {
    const q = norm(valueStr);
    const freq = parseFrequency(q);
    let opt = [...input.options].find((o) => norm(o.textContent) === q) ||
              [...input.options].find((o) => norm(o.textContent).includes(q) || q.includes(norm(o.textContent))) ||
              (freq && [...input.options].find((o) => o.value === freq.id));
    if (!opt) { feedback(`I don't see an option like "${valueStr}" for ${f.label}.`); return; }
    input.value = opt.value;
    feedback(`${f.label}: ${opt.textContent}.`);
  } else if (input.type === "date") {
    const d = parseSpokenDate(valueStr);
    if (!d) { feedback(`I couldn't understand the date "${valueStr}".`); return; }
    input.value = d;
    feedback(`${f.label}: ${fmtDate(d)}.`);
  } else if (input.type === "number") {
    const n = parseAmount(valueStr);
    if (n == null) { feedback(`I didn't hear a number in "${valueStr}".`); return; }
    input.value = n;
    feedback(`${f.label}: ${n}.`);
  } else {
    input.value = titleWords(valueStr);
    feedback(`${f.label}: ${input.value}.`);
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---- help ----

function showHelp() {
  openModal(`
    <h2>🎤 Voice commands</h2>
    <div class="voice-help">
      <div class="vh-group"><b>Navigate</b>
        <div>"go to bills" · "open calendar" · "open budget" · "show net worth" · "dashboard" · "debt payoff" · "import" — on the calendar: "next month" · "previous month" · "this month"</div></div>
      <div class="vh-group"><b>Add things</b>
        <div>"add bill rent 1450 monthly due on the 31st"<br>"add account visa credit card balance 4800 interest 24.99"<br>"add income paycheck 2150 every two weeks"<br>"add spending groceries 520"</div></div>
      <div class="vh-group"><b>While a form is open</b>
        <div>"amount 1500" · "due date August 1st" · "category utilities" · "autopay on" · then <b>"save"</b> or "cancel"</div></div>
      <div class="vh-group"><b>Update</b>
        <div>"change rent amount to 1500" · "set visa balance to 4000" · "change electric due date to the 21st" · "rename gym to Planet Fitness" · "turn on autopay for internet"</div></div>
      <div class="vh-group"><b>Pay & delete</b>
        <div>"pay rent" · "mark electric paid" · "delete bill gym" (asks you to say "confirm")</div></div>
      <div class="vh-group"><b>Other</b>
        <div>"export backup" · "help" · "stop listening" — or press <b>V</b> to toggle the mic</div></div>
      <div class="small muted">Speech is handled by your browser's speech engine. Chrome may use its online speech service for recognition; Safari processes on-device. Your finance data itself never leaves this computer.</div>
    </div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="document.getElementById('modal-root').innerHTML=''">Got it</button></div>
  `);
}
