// Financial engines: pay-period budget forecast, net-worth projection,
// debt payoff simulation (avalanche vs snowball), recurring-charge detection.

import {
  addDays, addMonths, daysBetween, monthlyAmount, nextOccurrence,
  occurrencesInRange, parseYMD, sum, todayStr, toYMD,
} from "./utils.js";
import { activeBills, checkingBalance, debts, getState, netWorth } from "./store.js";

// ---------- Pay-period budget forecast ----------
// Builds consecutive periods delimited by the primary income's paydays and
// projects the checking balance through each: start + income − bills − planned spending.
export function buildPayPeriods(numPeriods = 8) {
  const s = getState();
  const today = todayStr();
  const primary = s.incomes.find((i) => i.primary) || s.incomes[0];
  const periods = [];
  if (!primary || !primary.nextDate) return { periods, primary: null };

  // Anchor: the payday that starts the current period (roll back if next is in future)
  let payday = primary.nextDate;
  // If nextDate drifted into the past, roll forward to the first payday >= today... but
  // the *current* period started at the last payday, so track boundaries from nextDate.
  let guard = 0;
  while (payday <= today && nextOccurrence(payday, primary.frequency) && guard++ < 60) {
    const nx = nextOccurrence(payday, primary.frequency);
    if (nx > today) break;
    payday = nx;
  }
  // Period 0 runs from today to the day before the next payday.
  const boundaries = [];
  let b = payday <= today ? nextOccurrence(payday, primary.frequency) : payday;
  guard = 0;
  while (boundaries.length < numPeriods + 1 && b && guard++ < 200) {
    boundaries.push(b);
    b = nextOccurrence(b, primary.frequency);
  }

  const monthlyPlanned = sum(s.budgetItems, (i) => +i.amountPerMonth || 0);
  let balance = checkingBalance();
  let from = today;

  for (let p = 0; p < numPeriods && p < boundaries.length; p++) {
    const to = addDays(boundaries[p], -1); // period ends the day before next payday
    const days = Math.max(1, daysBetween(from, to) + 1);

    // Income: every income occurrence that lands inside [from, to]
    let income = 0;
    const incomeEvents = [];
    for (const inc of s.incomes) {
      for (const d of occurrencesInRange(inc.nextDate, inc.frequency, from, to)) {
        income += +inc.amount || 0;
        incomeEvents.push({ date: d, name: inc.name, amount: +inc.amount || 0 });
      }
    }

    // Bills due inside the window
    const billEvents = [];
    for (const bill of activeBills()) {
      for (const d of occurrencesInRange(bill.nextDue, bill.frequency, from, to)) {
        billEvents.push({ date: d, name: bill.name, amount: +bill.amount || 0, billId: bill.id });
      }
    }
    const billsTotal = sum(billEvents, (e) => e.amount);
    const planned = (monthlyPlanned * 12 / 365.25) * days;

    const start = balance;
    const end = start + income - billsTotal - planned;
    periods.push({
      from, to, days, income, incomeEvents,
      bills: billEvents.sort((a, b2) => a.date.localeCompare(b2.date)),
      billsTotal, planned, start, end, net: income - billsTotal - planned,
    });
    balance = end;
    from = boundaries[p];
  }
  return { periods, primary };
}

// ---------- Net worth projection ----------
// Month-by-month for `months`: debts accrue APR/12 then receive their scheduled
// payment; savings/investment/life insurance compound monthly at the account's
// own interest rate (APY), falling back to settings.savingsGrowthPct when the
// account has none; checking moves by estimated monthly net cash flow.
export function projectNetWorth(months = 24) {
  const s = getState();
  const defaultGrowthPct = +s.settings.savingsGrowthPct || 0;
  // Per-account monthly growth: the account's rate wins (0 is a real answer).
  const growthFor = (a) => ((a.apr ?? defaultGrowthPct) || 0) / 100 / 12;

  // Monthly cash flow estimate
  const incomeMo = sum(s.incomes, (i) => monthlyAmount(+i.amount || 0, i.frequency));
  const billsMo = sum(activeBills(), (b) => monthlyAmount(+b.amount || 0, b.frequency));
  const plannedMo = sum(s.budgetItems, (i) => +i.amountPerMonth || 0);
  const netFlowMo = incomeMo - billsMo - plannedMo;

  // Payment applied to each debt each month: linked bill amount if present, else min payment.
  const paymentFor = (acct) => {
    const linked = activeBills().find((b) => b.linkedAccountId === acct.id);
    if (linked) return monthlyAmount(+linked.amount || 0, linked.frequency);
    return +acct.minPayment || 0;
  };

  const accounts = s.accounts.map((a) => ({ ...a, balance: +a.balance || 0 }));
  const points = [];
  const start = netWorth();
  points.push({ month: 0, date: todayStr(), ...start });

  let cursor = todayStr();
  for (let m = 1; m <= months; m++) {
    cursor = addMonths(cursor, 1);
    for (const a of accounts) {
      if (a.type === "credit" || a.type === "loan") {
        if (a.balance <= 0) { a.balance = 0; continue; }
        const interest = a.balance * ((+a.apr || 0) / 100 / 12);
        a.balance = Math.max(0, a.balance + interest - paymentFor(a));
      } else if (a.type === "savings" || a.type === "investment" || a.type === "lifeins") {
        a.balance = a.balance * (1 + growthFor(a));
      } else if (a.type === "checking") {
        a.balance += netFlowMo;
      }
      // real estate, personal property, business equity: unchanged
    }
    let assets = 0, liabilities = 0;
    for (const a of accounts) {
      if (a.type === "credit" || a.type === "loan") liabilities += a.balance;
      else assets += a.balance;
    }
    points.push({ month: m, date: cursor, assets, liabilities, net: assets - liabilities });
  }
  return { points, assumptions: { incomeMo, billsMo, plannedMo, netFlowMo, growthPctYr: defaultGrowthPct } };
}

// ---------- Debt payoff: avalanche vs snowball ----------
export function simulatePayoff(strategy, extraMonthly = 0) {
  const list = debts().map((d) => ({
    id: d.id, name: d.name, balance: +d.balance || 0,
    apr: +d.apr || 0, min: Math.max(+d.minPayment || 0, 15),
  }));
  if (!list.length) return null;

  const order = [...list].sort((a, b) =>
    strategy === "avalanche" ? b.apr - a.apr || a.balance - b.balance : a.balance - b.balance || b.apr - a.apr
  );

  let month = 0, totalInterest = 0;
  const timeline = [{ month: 0, total: sum(list, (d) => d.balance) }];
  const payoffMonth = {};
  const MAX = 600;

  while (order.some((d) => d.balance > 0.005) && month < MAX) {
    month++;
    // interest accrual
    for (const d of order) {
      if (d.balance <= 0) continue;
      const i = d.balance * (d.apr / 100 / 12);
      d.balance += i;
      totalInterest += i;
    }
    // minimums on every open debt
    let extra = extraMonthly;
    for (const d of order) {
      if (d.balance <= 0) continue;
      const pay = Math.min(d.min, d.balance);
      d.balance -= pay;
      // freed-up minimums roll into extra automatically because closed debts skip this loop
    }
    // extra (plus rolled minimums of closed debts) targets the first open debt in strategy order
    let freed = sum(order.filter((d) => d.balance <= 0.005), (d) => d.min);
    let pool = extra + freed;
    for (const d of order) {
      if (pool <= 0) break;
      if (d.balance <= 0.005) continue;
      const pay = Math.min(pool, d.balance);
      d.balance -= pay;
      pool -= pay;
    }
    for (const d of order) {
      if (d.balance <= 0.005 && payoffMonth[d.id] == null) payoffMonth[d.id] = month;
    }
    timeline.push({ month, total: Math.max(0, sum(order, (d) => Math.max(0, d.balance))) });
  }

  return {
    strategy, months: month, totalInterest,
    debtFreeDate: addMonths(todayStr(), month),
    order: order.map((d) => ({ id: d.id, name: d.name, payoffMonth: payoffMonth[d.id] ?? null })),
    timeline,
    capped: month >= MAX,
  };
}

// ---------- Recurring-charge detection from imported transactions ----------
// Groups outflows by normalized merchant, then looks for regular intervals
// (weekly/biweekly/semimonthly/monthly/quarterly/annual) with similar amounts.
const NOISE_WORDS = /\b(pos|debit|credit|purchase|payment|pymt|ach|web|online|recurring|autopay|auto pay|withdrawal|deposit|card \d+|ref \d+|#\d+)\b/gi;

export function normalizeMerchant(desc) {
  return String(desc || "")
    .toUpperCase()
    .replace(/\d{4,}/g, " ")           // long numbers (card refs, phone)
    .replace(NOISE_WORDS, " ")
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ").slice(0, 3).join(" "); // first 3 significant words
}

const INTERVAL_MAP = [
  { freq: "weekly", days: 7, tol: 2 },
  { freq: "biweekly", days: 14, tol: 3 },
  { freq: "semimonthly", days: 15.2, tol: 3 },
  { freq: "monthly", days: 30.4, tol: 5 },
  { freq: "quarterly", days: 91.3, tol: 10 },
  { freq: "annual", days: 365.25, tol: 15 },
];

export function detectRecurring(transactions) {
  const outflows = transactions.filter((t) => t.amount < 0);
  const groups = new Map();
  for (const t of outflows) {
    const key = normalizeMerchant(t.description);
    if (!key || key.length < 3) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const suggestions = [];
  for (const [merchant, txs] of groups) {
    if (txs.length < 2) continue;
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) intervals.push(daysBetween(sorted[i - 1].date, sorted[i].date));
    const valid = intervals.filter((d) => d > 2);
    if (!valid.length) continue;
    const avg = sum(valid) / valid.length;

    const match = INTERVAL_MAP.find((m) => Math.abs(avg - m.days) <= m.tol);
    if (!match) continue;
    // require intervals to be reasonably consistent
    const consistent = valid.every((d) => Math.abs(d - match.days) <= match.tol * 2);
    if (!consistent && valid.length > 1) continue;

    const amounts = sorted.map((t) => Math.abs(t.amount));
    const avgAmt = sum(amounts) / amounts.length;
    const spread = Math.max(...amounts) - Math.min(...amounts);
    const variable = spread > avgAmt * 0.2;
    // annual needs 2+ points, monthly-and-faster benefit from 2+ as well
    if (txs.length < (match.days > 45 ? 2 : 2)) continue;

    const lastDate = sorted[sorted.length - 1].date;
    let nextDue = nextOccurrence(lastDate, match.freq) || lastDate;
    const today = todayStr();
    let guard = 0;
    while (nextDue < today && guard++ < 60) nextDue = nextOccurrence(nextDue, match.freq);

    suggestions.push({
      merchant,
      sampleDescription: sorted[sorted.length - 1].description,
      count: txs.length,
      frequency: match.freq,
      avgAmount: Math.round(avgAmt * 100) / 100,
      lastAmount: amounts[amounts.length - 1],
      variable,
      lastDate, nextDue,
      dates: sorted.map((t) => t.date),
    });
  }
  return suggestions.sort((a, b) => b.avgAmount - a.avgAmount);
}

// ---------- CSV parsing ----------
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f.trim() !== "")) rows.push(row); }
  return rows;
}

const DATE_PATTERNS = [
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})/, fn: (m) => [m[1], m[2], m[3]] },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})/, fn: (m) => [m[3], m[1], m[2]] },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, fn: (m) => [`20${m[3]}`, m[1], m[2]] },
  { re: /^(\d{1,2})-(\d{1,2})-(\d{4})/, fn: (m) => [m[3], m[1], m[2]] },
];

export function parseDateCell(s) {
  const t = String(s || "").trim();
  for (const p of DATE_PATTERNS) {
    const m = t.match(p.re);
    if (m) {
      const [y, mo, d] = p.fn(m).map(Number);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return toYMD(new Date(y, mo - 1, d));
    }
  }
  const d = new Date(t);
  if (!isNaN(d) && d.getFullYear() > 1990) return toYMD(d);
  return null;
}

export function parseAmountCell(s) {
  let t = String(s || "").trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.startsWith("-")) { neg = true; t = t.slice(1); }
  t = t.replace(/[$,\s]/g, "");
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const v = parseFloat(t);
  return neg ? -v : v;
}

// ---------- PDF statement text → transactions ----------
// Takes text lines extracted from a PDF statement and pulls out
// {date, description, amount} rows. Sign heuristics: section headers
// (Deposits/Withdrawals…) set the default; explicit -, (), or CR/keywords override.
const MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;
const MONTH_IDX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const SKIP_DESC = /^(total|subtotal|balance|beginning balance|ending balance|previous balance|new balance|statement|minimum payment|payment due|account number|page \d)/i;
// NOTE: bare "payment" is NOT a credit signal — charges like "VERIZON WIRELESS
// PAYMENT" would be misread as money-in. Card payments say "received"/"thank you".
const CREDIT_WORDS = /\b(payment (received|thank you)|thank you|deposit|refund|credit|reversal|cashback|cash back|interest paid|direct dep)\b/i;

export function parseStatementLines(lines) {
  const text = lines.join("\n");
  // infer the statement's year from the most recent plausible year mentioned
  const now = new Date();
  const years = [...text.matchAll(/\b(20[0-4]\d)\b/g)].map((m) => +m[1]).filter((y) => y <= now.getFullYear() + 1);
  const stmtYear = years.length ? Math.max(...years) : now.getFullYear();
  const horizon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 60);

  let mode = -1; // default sign for unsigned amounts in the current section
  const out = [];

  const mkDate = (y, mo, d) => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let dt = new Date(y, mo - 1, d);
    if (dt > horizon) dt = new Date(y - 1, mo - 1, d); // e.g. Dec dates on a January statement
    return toYMD(dt);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();

    // section headers flip the default sign (only short, amount-free lines)
    if (line.length < 60 && !/\d\.\d\d/.test(line)) {
      if (/(deposits|credits|payments and other credits|additions)/.test(lower)) { mode = +1; continue; }
      if (/(withdrawals|purchases|charges|debits|payments and other debits|subtractions|fees|checks)/.test(lower)) { mode = -1; continue; }
    }

    // date at the start of the line
    let date = null, rest = null;
    let m = line.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (m) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : stmtYear;
      date = mkDate(y, +m[1], +m[2]);
      rest = line.slice(m[0].length);
    } else {
      m = line.match(MONTH_RE);
      if (m) {
        date = mkDate(stmtYear, MONTH_IDX[m[1].slice(0, 3).toLowerCase()], +m[2]);
        rest = line.slice(m[0].length);
      }
    }
    if (!date || rest == null) continue;
    // some statements repeat a second (post) date right after — drop it
    rest = rest.replace(/^\s*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s+/, " ").trim();

    // amount at the end of the line
    const am = rest.match(/[-−(]?\s*\$?\s*\d{1,3}(?:,\d{3})*\.\d{2}\s*\)?\s*(CR|DR|-)?\s*$/i);
    if (!am) continue;
    const amtRaw = am[0];
    const val = parseFloat(amtRaw.replace(/[^0-9.]/g, ""));
    if (!(val > 0) || val > 500000) continue;

    let desc = rest.slice(0, am.index).replace(/\.{3,}|…/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!desc || SKIP_DESC.test(desc)) continue;

    const negMark = /^[-−(]/.test(amtRaw.trim()) || /-\s*$/.test(amtRaw);
    const crMark = /CR\s*$/i.test(amtRaw);
    let sign;
    if (crMark || CREDIT_WORDS.test(desc)) sign = +1;
    else if (negMark || /DR\s*$/i.test(amtRaw)) sign = -1;
    else sign = mode;

    out.push({ date, description: desc, amount: sign * val });
  }
  return out;
}

// Map arbitrary bank CSV rows to {date, description, amount} transactions.
// amount: negative = money out.
export function normalizeStatement(rows) {
  if (rows.length < 2) return { transactions: [], mapping: null };
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const findCol = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));

  let dateCol = findCol("date");
  let descCol = findCol("description", "payee", "merchant", "name", "memo", "details");
  let amtCol = findCol("amount");
  let debitCol = findCol("debit", "withdrawal");
  let creditCol = findCol("credit", "deposit");
  if (debitCol === amtCol) debitCol = -1;
  if (creditCol === amtCol) creditCol = -1;

  let dataRows = rows.slice(1);
  // Headerless CSV: guess columns from the first row's shapes
  if (dateCol === -1) {
    const probe = rows[0];
    dateCol = probe.findIndex((c) => parseDateCell(c));
    if (dateCol === -1) return { transactions: [], mapping: null };
    amtCol = probe.findIndex((c, i) => i !== dateCol && parseAmountCell(c) !== null && /[\d.]/.test(c));
    descCol = probe.findIndex((c, i) => i !== dateCol && i !== amtCol && String(c).trim().length > 2);
    dataRows = rows;
  }
  if (descCol === -1) descCol = header.findIndex((_, i) => i !== dateCol && i !== amtCol);

  const transactions = [];
  for (const r of dataRows) {
    const date = parseDateCell(r[dateCol]);
    if (!date) continue;
    let amount = null;
    if (debitCol >= 0 || creditCol >= 0) {
      const debit = debitCol >= 0 ? parseAmountCell(r[debitCol]) : null;
      const credit = creditCol >= 0 ? parseAmountCell(r[creditCol]) : null;
      if (debit != null && debit !== 0) amount = -Math.abs(debit);
      else if (credit != null && credit !== 0) amount = Math.abs(credit);
    } else if (amtCol >= 0) {
      amount = parseAmountCell(r[amtCol]);
    }
    if (amount == null) continue;
    const description = String(r[descCol] ?? "").trim() || "(no description)";
    transactions.push({ date, description, amount });
  }
  return {
    transactions,
    mapping: { dateCol, descCol, amtCol, debitCol, creditCol, hadHeader: dateCol !== -1 && rows[0] !== dataRows[0] },
  };
}
