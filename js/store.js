// App state: load/save via the local server, with schema defaults.

import { todayStr, uid } from "./utils.js";

const DEFAULTS = () => ({
  version: 1,
  settings: {
    checkingAccountId: null,   // account used as the spending balance for forecasts
    reminderDays: 10,          // "due soon" window
    savingsGrowthPct: 0,       // annual % applied to savings/investment in net-worth forecast
  },
  accounts: [],    // {id,name,type,balance,apr,minPayment,creditLimit,notes}
  bills: [],       // {id,name,amount,frequency,nextDue,category,autopay,linkedAccountId,notes,active}
  payments: [],    // {id,billId,billName,date,amount,forDate}
  incomes: [],     // {id,name,amount,frequency,nextDate}
  budgetItems: [], // {id,name,amountPerMonth}
  transactions: [],// {id,date,description,amount,source}
  customCategories: [], // user-added bill categories (strings)
});

// `group` drives the Net Worth "assets by category" breakdown.
export const ACCOUNT_TYPES = [
  { id: "checking", label: "Checking", asset: true, group: "Liquid assets" },
  { id: "savings", label: "Savings", asset: true, group: "Liquid assets" },
  { id: "investment", label: "Investment", asset: true, group: "Investments" },
  { id: "lifeins", label: "Life insurance (cash value)", asset: true, group: "Life insurance" },
  { id: "property", label: "Real estate / property", asset: true, group: "Real estate & property" },
  { id: "personal", label: "Personal property (vehicles, valuables)", asset: true, group: "Personal property" },
  { id: "business", label: "Business equity", asset: true, group: "Business equity" },
  { id: "credit", label: "Credit card", asset: false, group: "Debt" },
  { id: "loan", label: "Loan", asset: false, group: "Debt" },
];

export const BILL_CATEGORIES = [
  "Housing", "Utilities", "Insurance", "Debt", "Subscriptions", "Transportation",
  "Phone/Internet", "Medical", "Childcare", "Other",
];

// Built-in categories plus the user's custom ones, with "Other" kept last.
export const billCategories = () => {
  const custom = (state?.customCategories || []).filter((c) => !BILL_CATEGORIES.includes(c));
  return [...BILL_CATEGORIES.slice(0, -1), ...custom, "Other"];
};

let state = null;
let saveTimer = null;
let dirty = false; // true while a change hasn't reached the disk yet
const listeners = new Set();

export const getState = () => state;

export const onChange = (fn) => listeners.add(fn);

export async function loadState() {
  const res = await fetch("/api/data");
  const data = await res.json();
  state = Object.assign(DEFAULTS(), data || {});
  // Ensure nested defaults survive older saves
  state.settings = Object.assign(DEFAULTS().settings, state.settings || {});
  // Migration: valued assets gain estValue/principalBalance. The old model
  // stored equity directly in `balance` (homes kept the mortgage in
  // details.mortgageBalance), so reconstruct value = balance + principal —
  // balances are preserved exactly.
  for (const a of state.accounts) {
    if (!isValued(a) || a.estValue !== undefined) continue;
    const principal = +(a.details?.mortgageBalance) || 0;
    a.principalBalance = principal;
    a.estValue = (+a.balance || 0) + principal;
    if (a.details) delete a.details.mortgageBalance;
  }
  return state;
}

export function mutate(fn) {
  fn(state);
  scheduleSave();
  listeners.forEach((l) => l(state));
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const res = await fetch("/api/data", { method: "PUT", body: JSON.stringify(state, null, 2) });
      if (!res.ok) throw new Error("save failed");
      dirty = false;
      document.dispatchEvent(new CustomEvent("saved"));
    } catch (e) {
      document.dispatchEvent(new CustomEvent("save-error"));
    }
  }, 350);
}

// If the tab is closed/hidden while a save is still pending, push it out
// immediately — `keepalive` lets the request outlive the page.
function flushSave() {
  if (!dirty || !state) return;
  clearTimeout(saveTimer);
  const body = JSON.stringify(state, null, 2);
  try {
    fetch("/api/data", { method: "PUT", body, keepalive: true })
      .then(() => { dirty = false; })
      .catch(() => {});
  } catch {
    // last resort: sendBeacon POSTs; the server treats POST /api/data as a save
    try { navigator.sendBeacon("/api/data", new Blob([body], { type: "application/json" })); dirty = false; } catch {}
  }
}
window.addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});

// ---- Domain helpers ----

export const isDebt = (a) => a.type === "credit" || a.type === "loan";

// Valued assets (real estate, personal property, business equity) carry an
// estimated value and the loan principal still owed against it. Their
// `balance` is always the derived equity (estValue − principalBalance), so
// net worth, projections, and charts keep reading `balance` unchanged.
export const VALUED_TYPES = ["property", "personal", "business"];
export const isValued = (a) => VALUED_TYPES.includes(a.type);
export const syncValuedBalance = (a) => {
  if (!isValued(a) || a.estValue == null) return;
  a.balance = (+a.estValue || 0) - (+a.principalBalance || 0);
};

// Credit-usage guidance: cards above this share of their limit typically hurt
// credit scores. The UI flags them red; the Card Paydown page shows what
// payment brings each one back to the threshold.
export const CARD_UTIL_THRESHOLD = 0.3;
export const cardUtilization = (a) =>
  a.type === "credit" && +a.creditLimit > 0 ? (+a.balance || 0) / +a.creditLimit : null;

export const activeBills = () => state.bills.filter((b) => b.active !== false);

export const debts = () =>
  state.accounts.filter((a) => isDebt(a) && (+a.balance || 0) > 0);

export const netWorth = () => {
  let assets = 0, liabilities = 0;
  for (const a of state.accounts) {
    const bal = +a.balance || 0;
    if (ACCOUNT_TYPES.find((t) => t.id === a.type)?.asset) assets += bal;
    else liabilities += bal;
  }
  return { assets, liabilities, net: assets - liabilities };
};

export const checkingBalance = () => {
  const id = state.settings.checkingAccountId;
  const acct = state.accounts.find((a) => a.id === id) || state.accounts.find((a) => a.type === "checking");
  return acct ? +acct.balance || 0 : 0;
};

export const checkingAccount = () => {
  const id = state.settings.checkingAccountId;
  return state.accounts.find((a) => a.id === id) || state.accounts.find((a) => a.type === "checking") || null;
};

// Record a payment for a bill and roll its next due date forward.
export function payBill(bill, { amount, date } = {}) {
  mutate((s) => {
    const b = s.bills.find((x) => x.id === bill.id);
    if (!b) return;
    s.payments.push({
      id: uid(), billId: b.id, billName: b.name,
      date: date || todayStr(), amount: amount != null ? +amount : +b.amount,
      forDate: b.nextDue,
    });
    // If the bill pays down a linked debt account, reduce its balance.
    if (b.linkedAccountId) {
      const acct = s.accounts.find((a) => a.id === b.linkedAccountId);
      if (acct) acct.balance = Math.max(0, (+acct.balance || 0) - (amount != null ? +amount : +b.amount));
    }
    if (b.frequency === "once") b.active = false;
    else {
      // advance past today in case it was overdue by more than one cycle
      let next = b.nextDue;
      const today = todayStr();
      let guard = 0;
      do {
        const n = nextDueAfter(next, b.frequency);
        if (!n) break;
        next = n;
      } while (next <= today && ++guard < 60);
      b.nextDue = next;
    }
  });
}

import { nextOccurrence as nextDueAfter } from "./utils.js";
