// App shell: routing, modals, toasts, badge, backup/restore.

import { loadState, getState, mutate, onChange, activeBills, cardUtilization, CARD_UTIL_THRESHOLD } from "./store.js";
import { todayStr, addDays, esc, fmtMoney } from "./utils.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderBills } from "./views/bills.js";
import { renderCalendar } from "./views/calendar.js";
import { renderAccounts } from "./views/accounts.js";
import { renderBudget } from "./views/budget.js";
import { renderNetWorth } from "./views/networth.js";
import { renderPayoff } from "./views/payoff.js";
import { renderCards } from "./views/cards.js";
import { renderImport } from "./views/importview.js";
import { initVoice } from "./voice.js";

const VIEWS = {
  dashboard: renderDashboard,
  bills: renderBills,
  calendar: renderCalendar,
  accounts: renderAccounts,
  budget: renderBudget,
  networth: renderNetWorth,
  payoff: renderPayoff,
  cards: renderCards,
  import: renderImport,
};

const main = document.getElementById("main");

export function currentView() {
  const h = location.hash.replace("#", "");
  return VIEWS[h] ? h : "dashboard";
}

export function render() {
  const view = currentView();
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  main.innerHTML = "";
  VIEWS[view](main);
  updateBadge();
}

function updateBadge() {
  const badge = document.getElementById("bills-badge");
  const s = getState();
  const soon = addDays(todayStr(), s.settings.reminderDays || 10);
  const count = activeBills().filter((b) => b.nextDue && b.nextDue <= soon).length;
  badge.hidden = count === 0;
  badge.textContent = count;

  // Card Paydown badge: how many credit cards sit over the utilization line.
  const cardsBadge = document.getElementById("cards-badge");
  const overCards = s.accounts.filter((a) => (cardUtilization(a) ?? 0) > CARD_UTIL_THRESHOLD).length;
  cardsBadge.hidden = overCards === 0;
  cardsBadge.textContent = overCards;
}

// ---------- Modal ----------
export function openModal(innerHTML) {
  closeModal();
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${innerHTML}</div></div>`;
  const backdrop = root.firstElementChild;
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) closeModal(); });
  const esc_ = (e) => { if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", esc_); } };
  document.addEventListener("keydown", esc_);
  const first = backdrop.querySelector("input, select");
  if (first) first.focus();
  return backdrop.querySelector(".modal");
}
export function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

/**
 * Generic form modal. fields: [{name,label,type,options?,value?,required?,step?,hint?,placeholder?,chars?}]
 * type: text | number | date | select | checkbox
 * chars: minimum number of characters the input must show without clipping
 */
export function formModal({ title, fields, onSubmit, onDelete, submitLabel = "Save" }) {
  const fieldHTML = (f) => {
    const v = f.value ?? "";
    if (f.type === "select") {
      return `<label class="field"><span>${esc(f.label)}</span><select name="${f.name}">${f.options
        .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? "selected" : ""}>${esc(o.label)}</option>`)
        .join("")}</select></label>`;
    }
    if (f.type === "checkbox") {
      return `<label class="field" style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="${f.name}" style="width:auto" ${v ? "checked" : ""}><span style="margin:0">${esc(f.label)}</span></label>`;
    }
    return `<label class="field"><span>${esc(f.label)}</span><input name="${f.name}" type="${f.type || "text"}"
      value="${esc(v)}" ${f.required ? "required" : ""} ${f.step ? `step="${f.step}"` : ""}
      ${f.chars ? `style="min-width:calc(${f.chars}ch + 38px)"` : ""}
      ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ""} ${f.type === "number" ? 'inputmode="decimal"' : ""}>
      ${f.hint ? `<div class="form-hint">${esc(f.hint)}</div>` : ""}</label>`;
  };

  // pair up short fields
  let body = "";
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (f.half && fields[i + 1]?.half) {
      body += `<div class="field-row">${fieldHTML(f)}${fieldHTML(fields[i + 1])}</div>`;
      i += 2;
    } else {
      body += fieldHTML(f);
      i++;
    }
  }

  const modal = openModal(`
    <h2>${esc(title)}</h2>
    <form>${body}
      <div class="modal-actions">
        ${onDelete ? `<button type="button" class="btn btn-ghost btn-danger" data-act="delete">Delete</button>` : ""}
        <button type="button" class="btn" data-act="cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
      </div>
    </form>`);

  const form = modal.querySelector("form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
      const input = form.elements[f.name];
      if (!input) continue;
      if (f.type === "checkbox") out[f.name] = input.checked;
      else if (f.type === "number") out[f.name] = input.value === "" ? null : parseFloat(input.value);
      else out[f.name] = input.value;
    }
    onSubmit(out);
    closeModal();
    render();
  });
  modal.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
  if (onDelete) modal.querySelector('[data-act="delete"]').addEventListener("click", () => {
    if (confirm("Delete this item? This cannot be undone.")) { onDelete(); closeModal(); render(); }
  });
  return modal;
}

// ---------- Toast ----------
export function toast(msg) {
  const root = document.getElementById("toast-root");
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 320); }, 2600);
}

// ---------- Backup / restore ----------
document.getElementById("btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(getState(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `finance-control-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Backup downloaded");
});
document.getElementById("btn-import-backup").addEventListener("click", () => {
  document.getElementById("backup-file-input").click();
});
document.getElementById("backup-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== "object" || !("bills" in data)) throw new Error("not a backup");
    if (!confirm("Replace ALL current data with this backup?")) return;
    mutate((s) => Object.assign(s, data));
    render();
    toast("Backup restored");
  } catch {
    toast("That file doesn't look like a Finance Control backup");
  } finally {
    e.target.value = "";
  }
});

// ---------- Save indicator ----------
const saveStatus = document.getElementById("save-status");
let saveErrorToastShown = false;
document.addEventListener("saved", () => {
  saveStatus.textContent = "All changes saved locally";
  saveStatus.style.color = "";
  saveErrorToastShown = false;
});
document.addEventListener("save-error", () => {
  saveStatus.textContent = "⚠ Could not save — is server.py running?";
  saveStatus.style.color = "var(--status-critical)";
  if (!saveErrorToastShown) {
    saveErrorToastShown = true;
    toast("⚠ Your last change could NOT be saved — check the local server");
  }
});

// ---------- Monthly home value refresh ----------
// Home assets with an address and a previous AI estimate get re-estimated
// automatically once the estimate is 30+ days old, so net worth stays current.
async function refreshHomeValues() {
  const DAY = 86400e3;
  const stale = getState().accounts.filter((a) =>
    a.type === "property" && a.details?.kind === "home" && a.details.address &&
    a.details.estimate && a.details.autoUpdate !== false &&
    (!a.details.estimate.date || Date.now() - new Date(a.details.estimate.date) > 30 * DAY));
  if (!stale.length) return;
  try {
    const { ai } = await (await fetch("/api/ai-status")).json();
    if (!ai) return;
    for (const a of stale) {
      toast(`Updating home value for ${a.name}… (1–3 min)`);
      const site = a.details.siteEstimates || {};
      const res = await (await fetch("/api/estimate-home", {
        method: "POST",
        body: JSON.stringify({
          address: a.details.address,
          notes: a.details.notes,
          ...(Object.values(site).some((v) => v > 0)
            ? { site_estimates: { ...site, as_of: a.details.siteEstimatesDate } } : {}),
        }),
      })).json();
      if (res.error) { toast(`Couldn't update ${a.name}: ${res.error}`); continue; }
      let applied = res.estimated_value;
      mutate((s) => {
        const acct = s.accounts.find((x) => x.id === a.id);
        if (!acct) return;
        acct.details.estimate = res;
        // The estimate fills estValue; balance is the derived equity.
        acct.estValue = res.estimated_value;
        applied = res.estimated_value - (+acct.principalBalance || 0);
        acct.balance = applied;
      });
      toast(`${a.name} updated: value ${fmtMoney(res.estimated_value)}, equity ${fmtMoney(applied)}`);
      render();
    }
  } catch { /* offline or server restarting — try again next launch */ }
}

// ---------- Boot ----------
window.addEventListener("hashchange", render);
onChange(() => updateBadge());

loadState().then(() => {
  render();
  initVoice();
  refreshHomeValues();
}).catch(() => {
  main.innerHTML = `<div class="empty-state"><div class="big">Can't reach the local server</div>
    <p>Start it with <code>python3 server.py</code> from the Finance Control folder, then reload this page.</p></div>`;
});
