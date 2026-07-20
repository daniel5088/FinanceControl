// Budget & Forecast: pay-period ledger with projected balances.

import { getState } from "../store.js";
import { buildPayPeriods } from "../engine.js";
import { lineChart } from "../charts.js";
import { esc, fmtMoney, fmtDate, freqLabel, sum } from "../utils.js";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function renderBudget(main) {
  const s = getState();
  const { periods, primary } = buildPayPeriods(8);

  if (!primary) {
    main.innerHTML = `
      <div class="view-head"><div><div class="view-title">Budget &amp; Forecast</div></div></div>
      <div class="card"><div class="empty-state">
        <div class="big">Add your income first</div>
        <p>The budget follows your actual pay periods. Add your paycheck (amount, frequency, next payday) and this page will forecast your balance through each one.</p>
        <a class="btn btn-primary" href="#accounts">Add income</a>
      </div></div>`;
    return;
  }

  const lowest = periods.reduce((min, p) => (p.end < min.end ? p : min), periods[0]);
  const negative = periods.filter((p) => p.end < 0);

  main.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Budget &amp; Forecast</div>
        <div class="view-sub">Paid ${esc(freqLabel(primary.frequency).toLowerCase())} · next payday ${fmtDate(primary.nextDate)} · planned spending ${fmtMoney(sum(s.budgetItems, (i) => +i.amountPerMonth || 0))}/mo spread across periods</div>
      </div>
    </div>

    ${negative.length ? `<div class="card mb16" style="border-left:3px solid var(--status-critical)">
      <div class="card-title">⚠ Projected shortfall</div>
      <div class="small">Your balance is projected to go negative in ${negative.length} of the next ${periods.length} pay periods
      (lowest: <b class="neg">${fmtMoney(lowest.end)}</b> by ${fmtDate(lowest.to)}). Consider moving a bill's due date, trimming planned spending, or lowering extra debt payments.</div>
    </div>` : `<div class="card mb16" style="border-left:3px solid var(--status-good)">
      <div class="card-title">✓ All pay periods stay positive</div>
      <div class="small">Lowest projected balance is <b>${fmtMoney(lowest.end)}</b> around ${fmtDate(lowest.to)}.</div>
    </div>`}

    <div class="card mb16">
      <div class="card-title">Cash on hand after each pay period</div>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Pay period</th><th class="num">Income</th><th class="num">Bills</th><th class="num">Planned</th><th class="num">Cash after</th></tr></thead>
        <tbody>
          ${periods.map((p, i) => `
            <tr>
              <td><div class="list-title">${i === 0 ? "Current period" : `Period ${i + 1}`}</div>
                  <div class="small muted">${fmtDate(p.from)} – ${fmtDate(p.to)}</div></td>
              <td class="num pos">+${fmtMoney(sum(p.incomeEvents, (e) => e.amount))}</td>
              <td class="num">−${fmtMoney(sum(p.bills, (e) => e.amount))} <span class="muted small">(${p.bills.length} bill${p.bills.length === 1 ? "" : "s"})</span></td>
              <td class="num muted">${p.planned > 0 ? `−${fmtMoney(p.planned)}` : "—"}</td>
              <td class="num"><b class="${p.end < 0 ? "neg" : "pos"}">${fmtMoney(p.end)}</b></td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      <div class="small muted section-gap">Each row: what comes in, what bills are due, and the cash left when the period ends. The itemized bills for every period are in the cards below.</div>
    </div>

    <div class="card mb16">
      <div class="card-title">Projected balance at the end of each pay period</div>
      <div id="chart-periods"></div>
    </div>

    <div class="grid cols-2">
      ${periods.map((p, i) => `
        <div class="card">
          <div class="card-title">
            ${i === 0 ? "Current period" : `Period ${i + 1}`} · ${fmtDate(p.from)} – ${fmtDate(p.to)}
            <span class="hint">${p.days} days</span>
          </div>
          <table class="data">
            <tbody>
              <tr><td class="muted">Starting balance</td><td class="num">${fmtMoney(p.start)}</td></tr>
              ${p.incomeEvents.map((e) => `<tr><td class="pos">+ ${esc(e.name)} <span class="muted small">${fmtDate(e.date)}</span></td><td class="num pos">+${fmtMoney(e.amount)}</td></tr>`).join("")}
              ${p.bills.map((e) => `<tr><td>− ${esc(e.name)} <span class="muted small">${fmtDate(e.date)}</span></td><td class="num">−${fmtMoney(e.amount)}</td></tr>`).join("")}
              ${p.planned > 0 ? `<tr><td class="muted">− Planned spending (${p.days} days)</td><td class="num">−${fmtMoney(p.planned)}</td></tr>` : ""}
              <tr><td><b>Projected ending balance</b></td><td class="num"><b class="${p.end < 0 ? "neg" : "pos"}">${fmtMoney(p.end)}</b></td></tr>
            </tbody>
          </table>
        </div>`).join("")}
    </div>
  `;

  lineChart(document.getElementById("chart-periods"), {
    money: true, height: 220, fillFirst: true,
    series: [{
      name: "Projected balance", color: css("--series-1"),
      values: periods.map((p) => ({ x: fmtDate(p.to), xFull: `${fmtDate(p.from)} – ${fmtDate(p.to)}`, y: Math.round(p.end) })),
    }],
  });
}
