// Card Paydown: credit-card utilization vs the 30% guideline, and the
// payment each card needs to get back to it.

import { getState, CARD_UTIL_THRESHOLD, cardUtilization } from "../store.js";
import { barList } from "../charts.js";
import { esc, fmtMoney, sum } from "../utils.js";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function renderCards(main) {
  const s = getState();
  const cards = s.accounts.filter((a) => a.type === "credit");
  const pct = CARD_UTIL_THRESHOLD * 100;

  if (!cards.length) {
    main.innerHTML = `
      <div class="view-head"><div><div class="view-title">Card Paydown</div></div></div>
      <div class="card"><div class="empty-state">
        <div class="big">No credit cards yet</div>
        <p>Add your credit cards (with their credit limits) on the Accounts page to track utilization here.</p>
        <a class="btn btn-primary" href="#accounts">Add accounts</a>
      </div></div>`;
    return;
  }

  const withLimit = cards.filter((a) => +a.creditLimit > 0);
  const noLimit = cards.filter((a) => !(+a.creditLimit > 0));

  // Payment that brings a card back to exactly the threshold.
  const payDown = (a) => Math.max(0, (+a.balance || 0) - CARD_UTIL_THRESHOLD * +a.creditLimit);
  const over = withLimit.filter((a) => cardUtilization(a) > CARD_UTIL_THRESHOLD);
  const totalBal = sum(withLimit, (a) => +a.balance || 0);
  const totalLimit = sum(withLimit, (a) => +a.creditLimit || 0);
  const totalPay = sum(over, payDown);
  const overallUtil = totalLimit ? totalBal / totalLimit : 0;

  const utilPill = (u) => {
    const shown = `${Math.round(u * 100)}% used`;
    if (u > CARD_UTIL_THRESHOLD)
      return `<span class="pill overdue"><span class="dot" style="background:var(--status-critical)"></span>${shown}</span>`;
    return `<span class="pill"><span class="dot" style="background:var(--series-4)"></span>${shown}</span>`;
  };

  main.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Card Paydown</div>
        <div class="view-sub">Keeping each card under ${pct}% of its limit protects your credit score</div>
      </div>
    </div>

    <div class="grid cols-3 mb16">
      <div class="card">
        <div class="stat-label">Cards over ${pct}%</div>
        <div class="stat-value ${over.length ? "neg" : "pos"}">${over.length} of ${withLimit.length}</div>
        <div class="stat-delta">with a credit limit set</div>
      </div>
      <div class="card">
        <div class="stat-label">Total to pay down</div>
        <div class="stat-value ${totalPay ? "neg" : "pos"}">${fmtMoney(totalPay)}</div>
        <div class="stat-delta">gets every card to ${pct}%</div>
      </div>
      <div class="card">
        <div class="stat-label">Overall utilization</div>
        <div class="stat-value ${overallUtil > CARD_UTIL_THRESHOLD ? "neg" : ""}">${Math.round(overallUtil * 100)}%</div>
        <div class="stat-delta">${fmtMoney(totalBal)} of ${fmtMoney(totalLimit)} total limit</div>
      </div>
    </div>

    <div class="card mb16">
      <div class="card-title">Utilization by card <span class="hint">red = over ${pct}%</span></div>
      <div id="chart-util"></div>
    </div>

    <div class="card mb16">
      <div class="card-title">Paydown plan</div>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Card</th><th class="num">Balance</th><th class="num">Limit</th><th>Utilization</th><th class="num">Pay down</th><th class="num">Balance after</th></tr></thead>
        <tbody>
          ${withLimit
            .sort((a, b) => (cardUtilization(b) || 0) - (cardUtilization(a) || 0))
            .map((a) => {
              const u = cardUtilization(a);
              const need = payDown(a);
              return `<tr>
                <td><div class="list-title">${esc(a.name)}</div></td>
                <td class="num"><b class="${u > CARD_UTIL_THRESHOLD ? "neg" : ""}">${fmtMoney(+a.balance || 0)}</b></td>
                <td class="num">${fmtMoney(+a.creditLimit)}</td>
                <td>${utilPill(u)}</td>
                <td class="num">${need ? `<b class="neg">${fmtMoney(need)}</b>` : `<span class="pos">✓ under ${pct}%</span>`}</td>
                <td class="num muted">${need ? fmtMoney(CARD_UTIL_THRESHOLD * +a.creditLimit) : "—"}</td>
              </tr>`;
            }).join("")}
        </tbody>
      </table></div>
      ${totalPay ? `<div class="small muted section-gap">Paying ${fmtMoney(totalPay)} total brings every card to exactly ${pct}% —
        pay a little more than the listed amounts to get safely under. Utilization is usually reported to credit bureaus
        on each card's statement closing date.</div>` : `<div class="small muted section-gap">All cards are at or under ${pct}% — nothing needed.</div>`}
    </div>

    ${noLimit.length ? `<div class="card">
      <div class="card-title">Missing credit limits</div>
      ${noLimit.map((a) => `<div class="list-row">
        <div class="list-main"><div class="list-title">${esc(a.name)}</div>
          <div class="small muted">Balance ${fmtMoney(+a.balance || 0)} — add its credit limit to track utilization</div></div>
        <button class="btn btn-sm" data-edit="${a.id}">Add limit</button>
      </div>`).join("")}
    </div>` : ""}
  `;

  barList(document.getElementById("chart-util"),
    withLimit.sort((a, b) => (cardUtilization(b) || 0) - (cardUtilization(a) || 0)).map((a) => {
      const u = cardUtilization(a);
      return {
        label: a.name,
        value: Math.round(u * 100),
        color: css(u > CARD_UTIL_THRESHOLD ? "--status-critical" : "--series-4"),
        sub: `${fmtMoney(+a.balance || 0)} of ${fmtMoney(+a.creditLimit)} limit`,
      };
    }), { money: false, max: 100, suffix: "%" });

  main.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const { accountForm } = await import("./accounts.js");
      accountForm(s.accounts.find((a) => a.id === btn.dataset.edit));
    })
  );
}
