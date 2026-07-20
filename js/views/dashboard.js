// Dashboard: reminders, stat tiles, balance forecast, category mix, debts.

import { getState, activeBills, netWorth, checkingBalance, checkingAccount, debts, payBill } from "../store.js";
import { buildPayPeriods, projectNetWorth } from "../engine.js";
import { lineChart, barList, sparkline } from "../charts.js";
import { render, toast } from "../app.js";
import {
  esc, fmtMoney, fmtMoneyCompact, fmtDate, fmtDateLong, relDue, todayStr,
  addDays, daysBetween, monthlyAmount, sum, fmtPct, parseYMD,
} from "../utils.js";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function renderDashboard(main) {
  const s = getState();
  const today = todayStr();

  if (!s.accounts.length && !s.bills.length && !s.incomes.length) {
    main.innerHTML = `
      <div class="view-head"><div><div class="view-title">Welcome to Finance Control</div>
      <div class="view-sub">Everything is stored in a plain file on this computer — nothing is uploaded anywhere.</div></div></div>
      <div class="card"><div class="empty-state">
        <div class="big">Let's set up in three quick steps</div>
        <p>1. Add your <b>accounts</b> (checking, savings, cards, loans) with balances and interest rates.<br>
           2. Add your <b>income</b> so budgets can follow your pay periods.<br>
           3. Add <b>bills</b> by hand — or upload a bank statement and I'll find the recurring ones.</p>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <a class="btn btn-primary" href="#accounts">Start with accounts</a>
          <a class="btn" href="#import">Upload a statement</a>
        </div>
      </div></div>`;
    return;
  }

  const reminderDays = s.settings.reminderDays || 10;
  const soonCutoff = addDays(today, reminderDays);
  const upcoming = activeBills()
    .filter((b) => b.nextDue)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const overdue = upcoming.filter((b) => b.nextDue < today);
  const dueSoon = upcoming.filter((b) => b.nextDue >= today && b.nextDue <= soonCutoff);
  const next30Total = sum(upcoming.filter((b) => b.nextDue <= addDays(today, 30)), (b) => +b.amount || 0);

  const nw = netWorth();
  const monthlyBills = sum(activeBills(), (b) => monthlyAmount(+b.amount || 0, b.frequency));
  const monthlyIncome = sum(s.incomes, (i) => monthlyAmount(+i.amount || 0, i.frequency));
  const monthlyPlanned = sum(s.budgetItems, (i) => +i.amountPerMonth || 0);
  const monthlyNet = monthlyIncome - monthlyBills - monthlyPlanned;

  const { periods } = buildPayPeriods(8);
  const nwProj = projectNetWorth(12);
  const acct = checkingAccount();

  main.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Dashboard</div>
        <div class="view-sub">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
      </div>
      <a class="btn" href="#import">⇪ Import statement</a>
    </div>

    ${overdue.length || dueSoon.length ? `
    <div class="card mb16" style="border-left:3px solid ${overdue.length ? "var(--status-critical)" : "var(--status-warning)"}">
      <div class="card-title">${overdue.length ? `⚠ ${overdue.length} overdue` : ""}${overdue.length && dueSoon.length ? " · " : ""}${dueSoon.length ? `${dueSoon.length} due in the next ${reminderDays} days` : ""}
        <span class="hint">mark paid to advance the due date</span></div>
      <div class="list">
        ${[...overdue, ...dueSoon].slice(0, 8).map((b) => `
          <div class="list-row">
            <div class="list-main">
              <div class="list-title">${esc(b.name)}${b.autopay ? ' <span class="muted small">· autopay</span>' : ""}</div>
              <div class="list-sub">${fmtDateLong(b.nextDue)}</div>
            </div>
            <span class="pill ${b.nextDue < today ? "overdue" : "soon"}"><span class="dot" style="background:${b.nextDue < today ? "var(--status-critical)" : "var(--status-warning)"}"></span>${esc(relDue(b.nextDue))}</span>
            <div class="list-amount">${fmtMoney(+b.amount)}</div>
            <button class="btn btn-sm" data-quickpay="${b.id}">Mark paid</button>
          </div>`).join("")}
      </div>
    </div>` : ""}

    <div class="grid cols-4 mb16">
      <div class="card">
        <div class="stat-label">Net worth</div>
        <div class="stat-row"><div class="stat-value hero">${fmtMoneyCompact(nw.net)}</div><div id="spark-nw"></div></div>
        <div class="stat-delta">${fmtMoney(nw.assets)} assets − ${fmtMoney(nw.liabilities)} debt</div>
      </div>
      <div class="card">
        <div class="stat-label">${acct ? esc(acct.name) : "Spending balance"}</div>
        <div class="stat-value">${fmtMoney(checkingBalance())}</div>
        <div class="stat-delta">${periods.length ? `→ ${fmtMoney(periods[0].end)} by ${fmtDate(periods[0].to)}` : "add income to forecast"}</div>
      </div>
      <div class="card">
        <div class="stat-label">Bills next 30 days</div>
        <div class="stat-value">${fmtMoney(next30Total)}</div>
        <div class="stat-delta">${upcoming.filter((b) => b.nextDue <= addDays(today, 30)).length} bills</div>
      </div>
      <div class="card">
        <div class="stat-label">Monthly cash flow</div>
        <div class="stat-value ${monthlyNet >= 0 ? "pos" : "neg"}">${monthlyNet >= 0 ? "+" : ""}${fmtMoney(monthlyNet)}</div>
        <div class="stat-delta">${fmtMoneyCompact(monthlyIncome)} in · ${fmtMoneyCompact(monthlyBills + monthlyPlanned)} out</div>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-title">Balance forecast by pay period <span class="hint"><a href="#budget" style="color:inherit">details →</a></span></div>
        <div id="chart-forecast"></div>
      </div>
      <div class="card">
        <div class="card-title">Monthly bills by category</div>
        <div id="chart-categories"></div>
      </div>
    </div>

    <div class="grid cols-2 section-gap">
      <div class="card">
        <div class="card-title">Net worth — next 12 months <span class="hint"><a href="#networth" style="color:inherit">details →</a></span></div>
        <div id="chart-nw"></div>
      </div>
      <div class="card">
        <div class="card-title">Debts <span class="hint"><a href="#payoff" style="color:inherit">payoff plan →</a></span></div>
        <div id="chart-debts"></div>
        ${debts().length ? `<div class="small muted section-gap">Highest APR: ${(() => { const d = [...debts()].sort((a, b) => (+b.apr || 0) - (+a.apr || 0))[0]; return `${esc(d.name)} at ${fmtPct(d.apr)}`; })()} — target this first (avalanche).</div>` : ""}
      </div>
    </div>
  `;

  // Quick-pay buttons
  main.querySelectorAll("[data-quickpay]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const bill = s.bills.find((b) => b.id === btn.dataset.quickpay);
      payBill(bill, {});
      toast(`${bill.name} marked paid`);
      render();
    })
  );

  // Charts
  if (periods.length) {
    lineChart(document.getElementById("chart-forecast"), {
      money: true, height: 210, fillFirst: true,
      series: [{
        name: "Projected balance", color: css("--series-1"),
        values: periods.map((p) => ({ x: fmtDate(p.to), xFull: `Pay period ending ${fmtDate(p.to)}`, y: Math.round(p.end) })),
      }],
    });
  } else {
    document.getElementById("chart-forecast").innerHTML = `<div class="chart-empty">Add an income on the <a href="#accounts">Accounts</a> page to see your pay-period forecast.</div>`;
  }

  // Category mix
  const catTotals = {};
  for (const b of activeBills()) {
    const c = b.category || "Other";
    catTotals[c] = (catTotals[c] || 0) + monthlyAmount(+b.amount || 0, b.frequency);
  }
  const catColors = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-7", "--series-8"];
  const items = Object.entries(catTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({ label, value: Math.round(value), color: css(catColors[Math.min(i, 7)]), sub: "per month" }));
  barList(document.getElementById("chart-categories"), items);

  // Net worth projection
  const nwPts = nwProj.points.filter((_, i) => i % 1 === 0);
  lineChart(document.getElementById("chart-nw"), {
    money: true, height: 210,
    series: [{
      name: "Net worth", color: css("--series-2"),
      values: nwPts.map((p) => ({ x: parseYMD(p.date).toLocaleDateString("en-US", { month: "short" }), xFull: fmtDate(p.date), y: Math.round(p.net) })),
    }],
  });

  // Debts bar list
  const debtItems = debts()
    .sort((a, b) => (+b.apr || 0) - (+a.apr || 0))
    .map((d, i) => ({
      label: d.name, value: Math.round(+d.balance),
      color: css(i === 0 ? "--series-6" : "--series-8"),
      sub: `${fmtPct(d.apr)} APR · min ${fmtMoney(+d.minPayment || 0)}`,
    }));
  if (debtItems.length) barList(document.getElementById("chart-debts"), debtItems);
  else document.getElementById("chart-debts").innerHTML = `<div class="chart-empty">No debts — nice. Add credit cards or loans on the Accounts page to plan payoffs.</div>`;

  // Net worth sparkline
  sparkline(document.getElementById("spark-nw"), nwProj.points.map((p) => p.net), css("--series-2"));
}
