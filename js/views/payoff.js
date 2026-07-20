// Debt payoff planner: avalanche vs snowball with extra-payment slider.

import { getState, debts } from "../store.js";
import { simulatePayoff } from "../engine.js";
import { lineChart } from "../charts.js";
import { esc, fmtMoney, fmtPct, fmtDate, addMonths, todayStr, sum, parseYMD } from "../utils.js";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function renderPayoff(main) {
  const list = debts();

  if (!list.length) {
    main.innerHTML = `
      <div class="view-head"><div><div class="view-title">Debt Payoff</div></div></div>
      <div class="card"><div class="empty-state">
        <div class="big">No debts to plan</div>
        <p>Add credit cards or loans on the Accounts page — with balance, APR, and minimum payment — and this page will compare payoff strategies for you.</p>
        <a class="btn btn-primary" href="#accounts">Add a debt account</a>
      </div></div>`;
    return;
  }

  const missingApr = list.filter((d) => !(+d.apr > 0));
  const extra = parseFloat(sessionStorage.getItem("payoffExtra") || "100");

  const av = simulatePayoff("avalanche", extra);
  const sn = simulatePayoff("snowball", extra);
  const savings = sn.totalInterest - av.totalInterest;
  const best = savings >= 0 ? av : sn;
  const monthsDiff = sn.months - av.months;

  main.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Debt Payoff</div>
        <div class="view-sub">${list.length} debts · ${fmtMoney(sum(list, (d) => +d.balance || 0))} total · ${fmtMoney(sum(list, (d) => +d.minPayment || 0))}/mo in minimums</div>
      </div>
      <label class="field" style="margin:0;width:220px"><span>Extra payment per month</span>
        <input id="extra-input" type="number" min="0" step="25" value="${extra}">
      </label>
    </div>

    ${missingApr.length ? `<div class="card mb16" style="border-left:3px solid var(--status-warning)">
      <div class="small">⚠ ${missingApr.map((d) => esc(d.name)).join(", ")} ${missingApr.length > 1 ? "have" : "has"} no APR set — interest is assumed 0%, which understates cost. Set APRs on the Accounts page for accurate plans.</div>
    </div>` : ""}

    <div class="card mb16" style="border-left:3px solid var(--status-good)">
      <div class="card-title">Recommendation</div>
      <div class="small">
        ${savings > 1 ? `
          Pay debts in <b>avalanche order</b> (highest APR first). With ${fmtMoney(extra)}/mo extra you'd be debt-free by
          <b>${fmtDate(av.debtFreeDate)}</b> and pay <b>${fmtMoney(av.totalInterest)}</b> in interest —
          saving <b class="pos">${fmtMoney(savings)}</b>${monthsDiff !== 0 ? ` and ${Math.abs(monthsDiff)} month${Math.abs(monthsDiff) > 1 ? "s" : ""}` : ""} versus snowball.
          Your first target: <b>${esc(av.orderNames?.[0] || [...list].sort((a, b) => (+b.apr || 0) - (+a.apr || 0))[0].name)}</b>.`
        : `
          Avalanche and snowball cost nearly the same here (${fmtMoney(Math.abs(savings))} apart), so pick <b>snowball</b>
          (smallest balance first) for the quick wins — first debt gone in ${sn.order.find((o) => o.payoffMonth)?.payoffMonth ?? "?"} month(s) —
          or avalanche if you prefer strict interest savings. Either way you're debt-free by <b>${fmtDate(best.debtFreeDate)}</b>.`}
        ${(av.capped || sn.capped) ? `<br><b class="neg">⚠ At this payment level the balances don't pay off within 50 years — minimums may not cover interest. Increase the extra payment.</b>` : ""}
      </div>
    </div>

    <div class="grid cols-2 mb16">
      ${[["Avalanche", av, "highest APR first — cheapest overall"], ["Snowball", sn, "smallest balance first — fastest wins"]].map(([name, r, sub]) => `
        <div class="card" ${r === best && savings > 1 ? 'style="outline:2px solid var(--status-good);outline-offset:-1px"' : ""}>
          <div class="card-title">${name} <span class="hint">${sub}</span></div>
          <div class="grid cols-3">
            <div><div class="stat-label">Debt-free</div><div class="stat-value" style="font-size:18px">${fmtDate(r.debtFreeDate)}</div></div>
            <div><div class="stat-label">Months</div><div class="stat-value" style="font-size:18px">${r.months}</div></div>
            <div><div class="stat-label">Total interest</div><div class="stat-value" style="font-size:18px">${fmtMoney(r.totalInterest)}</div></div>
          </div>
        </div>`).join("")}
    </div>

    <div class="card mb16">
      <div class="card-title">Total debt over time</div>
      <div id="chart-payoff"></div>
    </div>

    <div class="card">
      <div class="card-title">Payoff order — ${savings > 1 ? "avalanche (recommended)" : "snowball"}</div>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>#</th><th>Debt</th><th class="num">Balance</th><th class="num">APR</th><th class="num">Min payment</th><th>Paid off</th></tr></thead>
        <tbody>
          ${(savings > 1 ? av : sn).order.map((o, i) => {
            const d = list.find((x) => x.id === o.id);
            return `<tr>
              <td class="muted">${i + 1}</td>
              <td><b>${esc(d.name)}</b>${i === 0 ? ' <span class="pill ok">focus here</span>' : ""}</td>
              <td class="num">${fmtMoney(+d.balance)}</td>
              <td class="num">${fmtPct(d.apr)}</td>
              <td class="num">${fmtMoney(+d.minPayment || 0)}</td>
              <td>${o.payoffMonth ? fmtDate(addMonths(todayStr(), o.payoffMonth)) : "—"}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table></div>
      <div class="small muted section-gap">How it works: pay minimums on everything; all extra money (plus the minimums of debts you've finished) attacks the focus debt. Interest accrues monthly at APR ÷ 12.</div>
    </div>
  `;

  let debounce;
  document.getElementById("extra-input").addEventListener("input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      sessionStorage.setItem("payoffExtra", e.target.value || "0");
      renderPayoff(main);
    }, 400);
  });

  // chart: sample both timelines to a common length
  const maxMonths = Math.max(av.months, sn.months);
  const step = Math.max(1, Math.ceil(maxMonths / 36));
  const sample = (r) => {
    const out = [];
    for (let m = 0; m <= maxMonths; m += step) {
      const pt = r.timeline[Math.min(m, r.timeline.length - 1)];
      out.push({ x: m % 12 === 0 ? `${m / 12}y` : `${m}m`, xFull: fmtDate(addMonths(todayStr(), m)), y: Math.round(pt ? pt.total : 0) });
    }
    return out;
  };
  lineChart(document.getElementById("chart-payoff"), {
    money: true, height: 230,
    series: [
      { name: "Avalanche", color: css("--series-1"), values: sample(av) },
      { name: "Snowball", color: css("--series-8"), values: sample(sn) },
    ],
  });
}
