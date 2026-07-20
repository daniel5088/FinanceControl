// Calendar: month grid of bill due dates, paydays, and recorded payments.

import { getState, activeBills, payBill } from "../store.js";
import { render, toast } from "../app.js";
import { billForm, paymentForm } from "./bills.js";
import { incomeForm } from "./accounts.js";
import {
  esc, fmtMoney, fmtDate, todayStr, toYMD, parseYMD, addDays,
  occurrencesInRange, sum,
} from "../utils.js";

// month being viewed, as "YYYY-MM"; survives re-renders within the session
function viewMonth() {
  return sessionStorage.getItem("calMonth") || todayStr().slice(0, 7);
}
function setViewMonth(ym) {
  sessionStorage.setItem("calMonth", ym);
}
export function shiftCalendarMonth(delta) {
  const [y, m] = viewMonth().split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  setViewMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
}
export function resetCalendarMonth() {
  sessionStorage.removeItem("calMonth");
}

export function renderCalendar(main) {
  const s = getState();
  const today = todayStr();
  const ym = viewMonth();
  const [year, month] = ym.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const monthStart = toYMD(first);
  const monthEnd = toYMD(last);
  // grid runs from the Sunday on/before the 1st to the Saturday on/after the last day
  const gridStart = addDays(monthStart, -first.getDay());
  const gridEnd = addDays(monthEnd, 6 - last.getDay());

  // ---- collect events per day ----
  const events = new Map(); // ymd -> [{kind, label, amount, obj, cls}]
  const push = (d, ev) => { if (!events.has(d)) events.set(d, []); events.get(d).push(ev); };

  for (const b of activeBills()) {
    if (!b.nextDue) continue;
    for (const d of occurrencesInRange(b.nextDue, b.frequency, gridStart, gridEnd)) {
      const overdue = d < today;
      push(d, {
        kind: "bill", obj: b, label: b.name, amount: +b.amount || 0,
        cls: overdue ? "ev-overdue" : "ev-bill",
        isDue: d === b.nextDue, // only the next occurrence can be marked paid
      });
    }
  }
  for (const inc of s.incomes) {
    if (!inc.nextDate) continue;
    for (const d of occurrencesInRange(inc.nextDate, inc.frequency, gridStart, gridEnd)) {
      push(d, { kind: "income", obj: inc, label: inc.name, amount: +inc.amount || 0, cls: "ev-income" });
    }
  }
  for (const p of s.payments) {
    if (p.date >= gridStart && p.date <= gridEnd) {
      push(p.date, { kind: "payment", obj: p, label: p.billName, amount: +p.amount || 0, cls: "ev-paid" });
    }
  }

  // ---- month totals ----
  let billsTotal = 0, incomeTotal = 0;
  for (const [d, list] of events) {
    if (d < monthStart || d > monthEnd) continue;
    for (const ev of list) {
      if (ev.kind === "bill") billsTotal += ev.amount;
      if (ev.kind === "income") incomeTotal += ev.amount;
    }
  }

  const monthName = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const isThisMonth = ym === today.slice(0, 7);

  // ---- build grid ----
  let cells = "";
  let d = gridStart;
  while (d <= gridEnd) {
    const inMonth = d >= monthStart && d <= monthEnd;
    const dayNum = parseYMD(d).getDate();
    const list = (events.get(d) || []).sort((a, b) =>
      ({ payment: 0, income: 1, bill: 2 }[a.kind] - { payment: 0, income: 1, bill: 2 }[b.kind]));
    const MAX = 3;
    const shown = list.slice(0, MAX);
    const extra = list.length - shown.length;
    const chips = shown.map((ev, i) => {
      const sign = ev.kind === "income" ? "+" : "";
      const mark = ev.kind === "payment" ? "✓ " : "";
      const idx = `${d}:${list.indexOf(ev)}`;
      return `<button class="cal-ev ${ev.cls}" data-ev="${idx}"
        title="${esc(`${ev.kind === "payment" ? "Paid" : ev.kind === "income" ? "Payday" : "Due"}: ${ev.label} — ${fmtMoney(ev.amount)}`)}">
        <span class="cal-ev-name">${mark}${esc(ev.label)}</span><span class="cal-ev-amt">${sign}${fmtMoney(ev.amount, { cents: false })}</span>
      </button>`;
    }).join("");
    const more = extra > 0 ? `<div class="cal-more" title="${esc(list.slice(MAX).map((e) => `${e.label} ${fmtMoney(e.amount)}`).join("\n"))}">+${extra} more</div>` : "";
    cells += `<div class="cal-cell ${inMonth ? "" : "cal-out"} ${d === today ? "cal-today" : ""}" data-day="${d}">
      <div class="cal-daynum">${dayNum}</div>${chips}${more}
    </div>`;
    d = addDays(d, 1);
  }

  main.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Calendar</div>
        <div class="view-sub">${monthName}: ${fmtMoney(billsTotal)} in bills · ${fmtMoney(incomeTotal)} income
          · net <b class="${incomeTotal - billsTotal >= 0 ? "pos" : "neg"}">${incomeTotal - billsTotal >= 0 ? "+" : ""}${fmtMoney(incomeTotal - billsTotal)}</b>
          <span class="muted">(before planned spending)</span></div>
      </div>
      <div class="cal-nav">
        <button class="btn" id="cal-prev" title="Previous month">‹</button>
        <button class="btn" id="cal-today" ${isThisMonth ? "disabled" : ""}>Today</button>
        <button class="btn" id="cal-next" title="Next month">›</button>
      </div>
    </div>

    <div class="card cal-card">
      <div class="cal-grid cal-head-row">
        ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => `<div class="cal-wd">${w}</div>`).join("")}
      </div>
      <div class="cal-grid" id="cal-grid">${cells}</div>
      <div class="chart-legend section-gap">
        <span class="legend-item"><span class="swatch" style="background:var(--series-1)"></span>Bill due</span>
        <span class="legend-item"><span class="swatch" style="background:var(--status-critical)"></span>Overdue</span>
        <span class="legend-item"><span class="swatch" style="background:var(--series-4)"></span>Payday</span>
        <span class="legend-item"><span class="swatch" style="background:var(--baseline)"></span>Payment made</span>
      </div>
    </div>
  `;

  main.querySelector("#cal-prev").addEventListener("click", () => { shiftCalendarMonth(-1); renderCalendar(main); });
  main.querySelector("#cal-next").addEventListener("click", () => { shiftCalendarMonth(1); renderCalendar(main); });
  main.querySelector("#cal-today").addEventListener("click", () => { resetCalendarMonth(); renderCalendar(main); });

  // chip clicks: bills → edit (or quick-pay if due), income → edit, payment → edit/delete
  main.querySelectorAll("[data-ev]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [day, idxStr] = btn.dataset.ev.split(":");
      const list = (events.get(day) || []).sort((a, b) =>
        ({ payment: 0, income: 1, bill: 2 }[a.kind] - { payment: 0, income: 1, bill: 2 }[b.kind]));
      const ev = list[+idxStr];
      if (!ev) return;
      if (ev.kind === "bill") {
        if (ev.isDue && day <= addDays(today, 45)) openBillActions(ev.obj, day, main);
        else billForm(ev.obj);
      } else if (ev.kind === "income") {
        incomeForm(ev.obj);
      } else {
        paymentForm(ev.obj);
      }
    });
  });
}

// Small action sheet for a due bill: mark paid or edit.
import { openModal, closeModal } from "../app.js";
function openBillActions(bill, day, main) {
  const modal = openModal(`
    <h2>${esc(bill.name)}</h2>
    <div class="small muted mb16">${fmtMoney(+bill.amount)} · due ${fmtDate(bill.nextDue)}${bill.autopay ? " · autopay" : ""}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary" data-act="pay">✓ Mark paid</button>
      <button class="btn" data-act="edit">Edit bill</button>
      <button class="btn btn-ghost" data-act="close">Close</button>
    </div>
  `);
  modal.querySelector('[data-act="pay"]').addEventListener("click", () => {
    payBill(bill, {});
    closeModal();
    toast(`${bill.name} marked paid`);
    render();
  });
  modal.querySelector('[data-act="edit"]').addEventListener("click", () => {
    closeModal();
    billForm(bill);
  });
  modal.querySelector('[data-act="close"]').addEventListener("click", closeModal);
}
