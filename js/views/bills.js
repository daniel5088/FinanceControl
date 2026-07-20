// Bills view: recurring bills with due dates, interest links, payment history.

import { getState, mutate, activeBills, payBill, billCategories, isDebt } from "../store.js";
import { formModal, openModal, closeModal, toast, render } from "../app.js";
import {
  esc, fmtMoney, fmtDate, fmtPct, freqLabel, FREQUENCIES, relDue,
  todayStr, addDays, daysBetween, uid, monthlyAmount, sum,
} from "../utils.js";

export function billForm(existing = {}, afterSave) {
  const s = getState();
  const debtAccounts = s.accounts.filter(isDebt);
  const modal = formModal({
    title: existing.id ? "Edit bill" : "Add bill",
    submitLabel: existing.id ? "Save" : "Add bill",
    fields: [
      { name: "name", label: "Name", value: existing.name, required: true, placeholder: "e.g. Rent, Electric, Car payment" },
      { name: "amount", label: "Amount", type: "number", step: "0.01", value: existing.amount, required: true, half: true },
      { name: "frequency", label: "Repeats", type: "select", value: existing.frequency || "monthly", options: FREQUENCIES.map((f) => ({ value: f.id, label: f.label })), half: true },
      { name: "nextDue", label: "Next due date", type: "date", value: existing.nextDue || todayStr(), required: true, half: true },
      {
        name: "category", label: "Category", type: "select", value: existing.category || "Other", half: true,
        options: [
          ...[...new Set([...billCategories(), ...(existing.category ? [existing.category] : [])])].map((c) => ({ value: c, label: c })),
          { value: "__new__", label: "+ New category…" },
        ],
      },
      {
        name: "linkedAccountId", label: "Pays down debt account (optional)", type: "select",
        value: existing.linkedAccountId || "",
        options: [{ value: "", label: "— none —" }, ...debtAccounts.map((a) => ({ value: a.id, label: `${a.name} (${fmtPct(a.apr)} APR)` }))],
      },
      { name: "autopay", label: "On autopay", type: "checkbox", value: existing.autopay },
      { name: "notes", label: "Notes", value: existing.notes, placeholder: "Optional" },
    ],
    onSubmit: (v) => {
      v.category = (v.category || "").trim() || "Other";
      mutate((st) => {
        if (!billCategories().includes(v.category)) (st.customCategories ||= []).push(v.category);
        if (existing.id) {
          const b = st.bills.find((x) => x.id === existing.id);
          Object.assign(b, v);
        } else {
          st.bills.push({ id: uid(), active: true, ...v });
        }
      });
      toast(existing.id ? "Bill updated" : "Bill added");
      if (afterSave) afterSave();
    },
    onDelete: existing.id ? () => mutate((st) => { st.bills = st.bills.filter((b) => b.id !== existing.id); }) : null,
  });

  // Picking "+ New category…" swaps the dropdown for a text input; the typed
  // name is saved to customCategories on submit.
  const catSelect = modal.querySelector('select[name="category"]');
  catSelect.addEventListener("change", () => {
    if (catSelect.value !== "__new__") return;
    const input = document.createElement("input");
    input.name = "category";
    input.required = true;
    input.placeholder = "New category name";
    input.maxLength = 40;
    catSelect.replaceWith(input);
    input.focus();
  });
}

// Manage custom categories: add, rename, delete. Built-in categories stay fixed.
// Deleting a category moves its bills to "Other"; renaming updates them.
export function manageCategoriesForm() {
  const s = getState();
  const custom = s.customCategories || [];
  const usage = (cat) => s.bills.filter((b) => b.category === cat).length;
  const usageLabel = (cat) => {
    const n = usage(cat);
    return n ? `${n} bill${n === 1 ? "" : "s"}` : "not in use";
  };
  const modal = openModal(`
    <h2>Manage categories</h2>
    ${custom.length ? custom.map((c, i) => `
      <div class="list-row">
        <div class="list-main"><div class="list-title">${esc(c)}</div>
          <div class="small muted">${usageLabel(c)}</div></div>
        <button class="btn btn-sm" data-rename="${i}">Rename</button>
        <button class="btn btn-sm btn-ghost btn-danger" data-del="${i}">Delete</button>
      </div>`).join("")
    : `<div class="muted small">No custom categories yet — add one below, or pick "+ New category…" while adding a bill.</div>`}
    <form id="cat-add" style="display:flex;gap:8px;margin-top:12px">
      <input name="newcat" placeholder="New category name" maxlength="40" required>
      <button class="btn" type="submit" style="white-space:nowrap">Add</button>
    </form>
    <div class="form-hint">Built-in categories (Housing, Utilities…) can't be changed.</div>
    <div class="modal-actions"><button class="btn" data-act="close">Done</button></div>
  `);

  modal.querySelector('[data-act="close"]').addEventListener("click", closeModal);

  modal.querySelector("#cat-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = e.target.elements.newcat.value.trim();
    if (!name) return;
    if (billCategories().some((c) => c.toLowerCase() === name.toLowerCase())) {
      toast(`"${name}" already exists`);
      return;
    }
    mutate((st) => (st.customCategories ||= []).push(name));
    manageCategoriesForm();
  });

  modal.querySelectorAll("[data-rename]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const old = custom[+btn.dataset.rename];
      const name = (prompt(`Rename "${old}" to:`, old) || "").trim();
      if (!name || name === old) return;
      if (billCategories().some((c) => c !== old && c.toLowerCase() === name.toLowerCase())) {
        toast(`"${name}" already exists`);
        return;
      }
      mutate((st) => {
        st.customCategories[st.customCategories.indexOf(old)] = name;
        st.bills.forEach((b) => { if (b.category === old) b.category = name; });
      });
      render();
      manageCategoriesForm();
    })
  );

  modal.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const cat = custom[+btn.dataset.del];
      const n = usage(cat);
      const msg = n
        ? `Delete "${cat}"? ${n} bill${n === 1 ? "" : "s"} using it will move to "Other".`
        : `Delete "${cat}"?`;
      if (!confirm(msg)) return;
      mutate((st) => {
        st.customCategories = st.customCategories.filter((c) => c !== cat);
        st.bills.forEach((b) => { if (b.category === cat) b.category = "Other"; });
      });
      render();
      manageCategoriesForm();
    })
  );
}

// Edit or delete a recorded payment. If the payment's bill pays down a linked
// debt account, the checkbox keeps that account's balance in sync: saving
// applies the amount change to it, deleting adds the payment back onto it.
// (The bill's next due date is never rolled back automatically — advancing it
// again would guess wrong for edited dates; the toast reminds the user.)
export function paymentForm(p) {
  const s = getState();
  const bill = s.bills.find((b) => b.id === p.billId);
  const linked = bill && s.accounts.find((a) => a.id === bill.linkedAccountId);
  const modal = formModal({
    title: `Edit payment — ${p.billName}`,
    submitLabel: "Save",
    fields: [
      { name: "amount", label: "Amount paid", type: "number", step: "0.01", value: p.amount, required: true, half: true },
      { name: "date", label: "Date paid", type: "date", value: p.date, required: true, half: true },
      { name: "forDate", label: "For due date (optional)", type: "date", value: p.forDate || "" },
      ...(linked ? [{
        name: "adjust", type: "checkbox", value: true,
        label: `Keep ${linked.name}'s balance in sync with this change`,
      }] : []),
    ],
    onSubmit: (v) => {
      mutate((st) => {
        const pay = st.payments.find((x) => x.id === p.id);
        if (!pay) return;
        const delta = (+v.amount || 0) - (+pay.amount || 0);
        pay.amount = +v.amount;
        pay.date = v.date;
        pay.forDate = v.forDate || "";
        if (v.adjust && linked && delta) {
          const acct = st.accounts.find((a) => a.id === linked.id);
          if (acct) acct.balance = Math.max(0, (+acct.balance || 0) - delta);
        }
      });
      toast("Payment updated");
    },
    onDelete: () => {
      const adjust = !!modal.querySelector('input[name="adjust"]')?.checked;
      mutate((st) => {
        const pay = st.payments.find((x) => x.id === p.id);
        if (!pay) return;
        if (adjust && linked) {
          const acct = st.accounts.find((a) => a.id === linked.id);
          if (acct) acct.balance = (+acct.balance || 0) + (+pay.amount || 0);
        }
        st.payments = st.payments.filter((x) => x.id !== p.id);
      });
      toast(bill ? "Payment deleted — check the bill's next due date if it was advanced" : "Payment deleted");
    },
  });
}

function payForm(bill) {
  formModal({
    title: `Record payment — ${bill.name}`,
    submitLabel: "Record payment",
    fields: [
      { name: "amount", label: "Amount paid", type: "number", step: "0.01", value: bill.amount, required: true, half: true },
      { name: "date", label: "Date paid", type: "date", value: todayStr(), required: true, half: true },
    ],
    onSubmit: (v) => {
      payBill(bill, { amount: v.amount, date: v.date });
      toast(`Payment recorded — next due ${fmtDate(getState().bills.find((b) => b.id === bill.id)?.nextDue)}`);
    },
  });
}

const PAYMENTS_SHOWN = 25;
let showAllPayments = false;

const duePill = (b) => {
  const d = daysBetween(todayStr(), b.nextDue);
  if (d < 0) return `<span class="pill overdue"><span class="dot" style="background:var(--status-critical)"></span>${esc(relDue(b.nextDue))}</span>`;
  if (d <= (getState().settings.reminderDays || 10)) return `<span class="pill soon"><span class="dot" style="background:var(--status-warning)"></span>${esc(relDue(b.nextDue))}</span>`;
  return `<span class="pill">${esc(relDue(b.nextDue))}</span>`;
};

export function renderBills(main) {
  const s = getState();
  const bills = activeBills().sort((a, b) => (a.nextDue || "9999").localeCompare(b.nextDue || "9999"));
  const monthly = sum(bills, (b) => monthlyAmount(+b.amount || 0, b.frequency));
  const inactive = s.bills.filter((b) => b.active === false);

  main.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Bills</div>
        <div class="view-sub">${bills.length} active · ≈ ${fmtMoney(monthly)} per month</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="manage-cats">Categories</button>
        <button class="btn btn-primary" id="add-bill">+ Add bill</button>
      </div>
    </div>
    <div class="card">
      ${bills.length ? `
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Bill</th><th>Status</th><th class="num">Amount</th><th>Repeats</th><th>Category</th><th></th></tr></thead>
        <tbody>
          ${bills.map((b) => {
            const linked = s.accounts.find((a) => a.id === b.linkedAccountId);
            return `<tr class="clickable" data-id="${b.id}">
              <td><div class="list-title">${esc(b.name)} ${b.autopay ? '<span class="muted small">· autopay</span>' : ""}</div>
                  <div class="small muted">Due ${fmtDate(b.nextDue)}${linked ? ` · pays ${esc(linked.name)} (${fmtPct(linked.apr)} APR)` : ""}</div></td>
              <td>${duePill(b)}</td>
              <td class="num"><b>${fmtMoney(+b.amount)}</b></td>
              <td>${esc(freqLabel(b.frequency))}</td>
              <td class="muted">${esc(b.category || "—")}</td>
              <td class="num"><button class="btn btn-sm" data-pay="${b.id}">Mark paid</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table></div>` : `
      <div class="empty-state">
        <div class="big">No bills yet</div>
        <p>Add your recurring bills by hand, or upload a bank statement on the Import page and I'll detect them for you.</p>
        <button class="btn btn-primary" id="add-bill-empty">+ Add your first bill</button>
      </div>`}
    </div>

    <div class="card section-gap">
      <div class="card-title">Payment history <span class="hint">${s.payments.length} payments recorded · click one to edit</span></div>
      ${s.payments.length ? `
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Date</th><th>Bill</th><th class="num">Amount</th><th>For due date</th></tr></thead>
        <tbody>
          ${[...s.payments].sort((a, b) => b.date.localeCompare(a.date)).slice(0, showAllPayments ? Infinity : PAYMENTS_SHOWN).map((p) => `
            <tr class="clickable" data-payid="${p.id}"><td>${fmtDate(p.date)}</td><td>${esc(p.billName)}</td><td class="num">${fmtMoney(+p.amount)}</td><td class="muted">${p.forDate ? fmtDate(p.forDate) : "—"}</td></tr>
          `).join("")}
        </tbody>
      </table></div>
      ${s.payments.length > PAYMENTS_SHOWN ? `
        <button class="btn btn-sm btn-ghost section-gap" id="toggle-payments">
          ${showAllPayments ? "Show recent only" : `Show all ${s.payments.length}`}
        </button>` : ""}` : `<div class="muted small">Payments you record with "Mark paid" show up here.</div>`}
    </div>

    ${inactive.length ? `<div class="card section-gap">
      <div class="card-title">Completed one-time bills</div>
      ${inactive.map((b) => `<div class="list-row"><div class="list-main"><div class="list-title muted">${esc(b.name)}</div></div>
        <div class="list-amount muted">${fmtMoney(+b.amount)}</div>
        <button class="btn btn-sm btn-ghost" data-restore="${b.id}">Restore</button></div>`).join("")}
    </div>` : ""}
  `;

  const add = () => billForm();
  main.querySelector("#add-bill")?.addEventListener("click", add);
  main.querySelector("#manage-cats")?.addEventListener("click", manageCategoriesForm);
  main.querySelector("#add-bill-empty")?.addEventListener("click", add);
  main.querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      billForm(s.bills.find((b) => b.id === tr.dataset.id));
    })
  );
  main.querySelectorAll("[data-pay]").forEach((btn) =>
    btn.addEventListener("click", () => payForm(s.bills.find((b) => b.id === btn.dataset.pay)))
  );
  main.querySelectorAll("tr[data-payid]").forEach((tr) =>
    tr.addEventListener("click", () => {
      const p = s.payments.find((x) => x.id === tr.dataset.payid);
      if (p) paymentForm(p);
    })
  );
  main.querySelector("#toggle-payments")?.addEventListener("click", () => {
    showAllPayments = !showAllPayments;
    render();
  });
  main.querySelectorAll("[data-restore]").forEach((btn) =>
    btn.addEventListener("click", () => {
      mutate((st) => { const b = st.bills.find((x) => x.id === btn.dataset.restore); if (b) b.active = true; });
      render();
    })
  );
}
