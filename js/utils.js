// Shared helpers: money, dates, recurrence math.

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const fmtMoney = (n, opts = {}) => {
  if (n == null || isNaN(n)) return "—";
  const abs = Math.abs(n);
  const s = abs.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: opts.cents === false ? 0 : 2,
    maximumFractionDigits: opts.cents === false ? 0 : 2,
  });
  return n < 0 ? `-${s}` : s;
};

// Compact form for chart labels / tiles: $4.2K, $1.3M
export const fmtMoneyCompact = (n) => {
  if (n == null || isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 10000) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1000) return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `${sign}$${abs.toFixed(0)}`;
};

export const fmtPct = (n) => (n == null || isNaN(n) ? "—" : `${(+n).toFixed(2).replace(/\.?0+$/, "")}%`);

// ---- Dates (all local, stored as YYYY-MM-DD) ----

export const todayStr = () => toYMD(new Date());

export const toYMD = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const parseYMD = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const addDays = (ymd, n) => {
  const d = parseYMD(ymd);
  d.setDate(d.getDate() + n);
  return toYMD(d);
};

// Add months, clamping day-of-month (Jan 31 + 1mo -> Feb 28/29).
export const addMonths = (ymd, n) => {
  const [y, m, day] = ymd.split("-").map(Number);
  const first = new Date(y, m - 1 + n, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  first.setDate(Math.min(day, lastDay));
  return toYMD(first);
};

export const daysBetween = (a, b) => Math.round((parseYMD(b) - parseYMD(a)) / 86400000);

export const fmtDate = (ymd) => {
  if (!ymd) return "—";
  const d = parseYMD(ymd);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};

export const fmtDateLong = (ymd) => parseYMD(ymd).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

export const relDue = (ymd) => {
  const n = daysBetween(todayStr(), ymd);
  if (n < -1) return `${-n} days overdue`;
  if (n === -1) return "1 day overdue";
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  return `Due in ${n} days`;
};

// ---- Recurrence ----

export const FREQUENCIES = [
  { id: "weekly", label: "Weekly", perYear: 52 },
  { id: "biweekly", label: "Every 2 weeks", perYear: 26 },
  { id: "semimonthly", label: "Twice a month (1st & 15th)", perYear: 24 },
  { id: "monthly", label: "Monthly", perYear: 12 },
  { id: "quarterly", label: "Quarterly", perYear: 4 },
  { id: "semiannual", label: "Every 6 months", perYear: 2 },
  { id: "annual", label: "Yearly", perYear: 1 },
  { id: "once", label: "One time", perYear: 0 },
];

export const freqLabel = (id) => (FREQUENCIES.find((f) => f.id === id) || {}).label || id;

// Next occurrence strictly after `ymd` for a given frequency.
export const nextOccurrence = (ymd, frequency) => {
  switch (frequency) {
    case "weekly": return addDays(ymd, 7);
    case "biweekly": return addDays(ymd, 14);
    case "semimonthly": {
      const d = parseYMD(ymd);
      if (d.getDate() < 15) return toYMD(new Date(d.getFullYear(), d.getMonth(), 15));
      return toYMD(new Date(d.getFullYear(), d.getMonth() + 1, 1));
    }
    case "monthly": return addMonths(ymd, 1);
    case "quarterly": return addMonths(ymd, 3);
    case "semiannual": return addMonths(ymd, 6);
    case "annual": return addMonths(ymd, 12);
    default: return null; // once
  }
};

// All occurrences of a bill/income in [from, to] inclusive, starting at anchor.
export const occurrencesInRange = (anchor, frequency, from, to, cap = 400) => {
  const out = [];
  let d = anchor;
  let guard = 0;
  while (d && d <= to && guard++ < cap) {
    if (d >= from) out.push(d);
    if (frequency === "once") break;
    d = nextOccurrence(d, frequency);
  }
  return out;
};

// Monthly-equivalent amount for a recurring item.
export const monthlyAmount = (amount, frequency) => {
  const f = FREQUENCIES.find((x) => x.id === frequency);
  if (!f || !f.perYear) return 0;
  return (amount * f.perYear) / 12;
};

// ---- Misc ----

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const sum = (arr, fn = (x) => x) => arr.reduce((a, b) => a + (fn(b) || 0), 0);

export const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
