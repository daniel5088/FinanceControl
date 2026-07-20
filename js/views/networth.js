// Net worth: current breakdown + multi-year projection.

import { getState, netWorth, ACCOUNT_TYPES, isDebt } from "../store.js";
import { projectNetWorth } from "../engine.js";
import { lineChart, barList } from "../charts.js";
import { esc, fmtMoney, fmtMoneyCompact, fmtDate, parseYMD } from "../utils.js";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function renderNetWorth(main) {
  const s = getState();
  const nw = netWorth();

  if (!s.accounts.length) {
    main.innerHTML = `
      <div class="view-head"><div><div class="view-title">Net Worth</div></div></div>
      <div class="card"><div class="empty-state">
        <div class="big">No accounts yet</div>
        <p>Net worth is everything you own minus everything you owe. Add your accounts with current balances to see it.</p>
        <a class="btn btn-primary" href="#accounts">Add accounts</a>
      </div></div>`;
    return;
  }

  const horizon = parseInt(sessionStorage.getItem("nwHorizon") || "24");
  const proj = projectNetWorth(horizon);
  const endPt = proj.points[proj.points.length - 1];
  const change = endPt.net - nw.net;

  main.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Net Worth</div>
        <div class="view-sub">Assets − debts, projected forward from today's balances</div>
      </div>
      <label class="field" style="margin:0;width:180px"><span>Forecast horizon</span>
        <select id="nw-horizon">
          ${[12, 24, 36, 60].map((m) => `<option value="${m}" ${m === horizon ? "selected" : ""}>${m} months</option>`).join("")}
        </select>
      </label>
    </div>

    <div class="grid cols-3 mb16">
      <div class="card">
        <div class="stat-label">Net worth today</div>
        <div class="stat-value hero">${fmtMoney(nw.net)}</div>
        <div class="stat-delta">${fmtMoney(nw.assets)} assets − ${fmtMoney(nw.liabilities)} debt</div>
      </div>
      <div class="card">
        <div class="stat-label">Projected in ${horizon} months</div>
        <div class="stat-value">${fmtMoney(endPt.net)}</div>
        <div class="stat-delta ${change >= 0 ? "up" : "down"}">${change >= 0 ? "▲" : "▼"} ${fmtMoney(Math.abs(change))} vs today</div>
      </div>
      <div class="card">
        <div class="stat-label">Assumed monthly net cash flow</div>
        <div class="stat-value ${proj.assumptions.netFlowMo >= 0 ? "pos" : "neg"}">${proj.assumptions.netFlowMo >= 0 ? "+" : ""}${fmtMoney(proj.assumptions.netFlowMo)}</div>
        <div class="stat-delta">income − bills − planned spending</div>
      </div>
    </div>

    <div class="card mb16">
      <div class="card-title">Projection — assets, debts, and net</div>
      <div id="chart-proj"></div>
      <div class="small muted section-gap">Assumptions: debts accrue interest monthly (APR ÷ 12) and receive their linked bill payment or minimum payment;
      savings, investments, and life insurance cash value compound monthly at each account's own interest rate (accounts without one use the
      ${proj.assumptions.growthPctYr}%/yr default from the Accounts page); checking moves by the monthly net cash flow above;
      real estate, personal property, and business equity stay flat.</div>
    </div>

    <div class="card mb16">
      <div class="card-title">Assets by category</div>
      <div id="chart-groups"></div>
      <div class="small muted section-gap">Liquid assets are checking + savings. Add life insurance cash value, personal property, or business equity
      as accounts of that type on the <a href="#accounts">Accounts page</a>.</div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-title">What you own</div>
        <div id="chart-assets"></div>
      </div>
      <div class="card">
        <div class="card-title">What you owe</div>
        <div id="chart-debts"></div>
      </div>
    </div>
  `;

  document.getElementById("nw-horizon").addEventListener("change", (e) => {
    sessionStorage.setItem("nwHorizon", e.target.value);
    renderNetWorth(main);
  });

  const every = Math.max(1, Math.floor(proj.points.length / 24));
  const pts = proj.points.filter((p, i) => i % every === 0 || i === proj.points.length - 1);
  const mLabel = (p) => parseYMD(p.date).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  lineChart(document.getElementById("chart-proj"), {
    money: true, height: 250,
    series: [
      { name: "Net worth", color: css("--series-2"), values: pts.map((p) => ({ x: mLabel(p), xFull: fmtDate(p.date), y: Math.round(p.net) })) },
      { name: "Assets", color: css("--series-1"), values: pts.map((p) => ({ x: mLabel(p), xFull: fmtDate(p.date), y: Math.round(p.assets) })) },
      { name: "Debts", color: css("--series-6"), values: pts.map((p) => ({ x: mLabel(p), xFull: fmtDate(p.date), y: Math.round(p.liabilities) })) },
    ],
  });

  const typeLabel = (t) => ACCOUNT_TYPES.find((x) => x.id === t)?.label || t;

  // Assets rolled up by category (group metadata on ACCOUNT_TYPES). Groups
  // with no accounts are listed at $0 so the categories are discoverable.
  const groupOrder = [...new Set(ACCOUNT_TYPES.filter((t) => t.asset).map((t) => t.group))];
  const groupTotals = groupOrder.map((g, i) => {
    const accts = s.accounts.filter((a) => ACCOUNT_TYPES.find((t) => t.id === a.type)?.group === g);
    return {
      label: g,
      value: Math.round(accts.reduce((acc, a) => acc + (+a.balance || 0), 0)),
      color: css(`--series-${(i % 6) + 1}`),
      sub: `${accts.length || "no"} account${accts.length === 1 ? "" : "s"}`,
    };
  });
  barList(document.getElementById("chart-groups"), groupTotals);

  barList(document.getElementById("chart-assets"),
    s.accounts.filter((a) => !isDebt(a)).sort((a, b) => (+b.balance || 0) - (+a.balance || 0))
      .map((a) => ({ label: a.name, value: Math.round(+a.balance || 0), color: css("--series-1"), sub: typeLabel(a.type) })));
  barList(document.getElementById("chart-debts"),
    s.accounts.filter(isDebt).sort((a, b) => (+b.balance || 0) - (+a.balance || 0))
      .map((a) => ({ label: a.name, value: Math.round(+a.balance || 0), color: css("--series-6"), sub: typeLabel(a.type) })));
}
