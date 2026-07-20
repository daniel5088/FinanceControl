// Accounts view: balances, interest rates, income sources, budget items.

import { getState, mutate, ACCOUNT_TYPES, isDebt, netWorth, activeBills, cardUtilization, CARD_UTIL_THRESHOLD, VALUED_TYPES, syncValuedBalance } from "../store.js";
import { formModal, openModal, closeModal, toast, render } from "../app.js";
import { billForm } from "./bills.js";
import { esc, fmtMoney, fmtPct, FREQUENCIES, freqLabel, todayStr, uid, monthlyAmount, sum, fmtDate } from "../utils.js";

export function accountForm(existing = {}, afterSave) {
  const modal = formModal({
    title: existing.id ? "Edit account" : "Add account",
    submitLabel: existing.id ? "Save" : "Add account",
    fields: [
      { name: "name", label: "Name", value: existing.name, required: true, placeholder: "e.g. Chase Checking, Visa, Car loan" },
      { name: "type", label: "Type", type: "select", value: existing.type || "checking", options: ACCOUNT_TYPES.map((t) => ({ value: t.id, label: t.label })), half: true },
      { name: "balance", label: "Current balance", type: "number", step: "0.01", value: existing.balance ?? "", required: true, half: true },
      { name: "estValue", label: "Estimated value", type: "number", step: "0.01", value: existing.estValue ?? "", hint: "What it would sell for today. The AI estimate (Details button) fills this in." },
      { name: "principalBalance", label: "Principal balance remaining", type: "number", step: "0.01", value: existing.principalBalance ?? "", hint: "Loan still owed against it (mortgage, vehicle loan…). Net worth counts estimated value − principal." },
      { name: "apr", label: "Interest rate (APR %)", type: "number", step: "0.01", value: existing.apr ?? "", half: true, chars: 6, hint: "For debts: the rate you're charged. Drives payoff plans." },
      { name: "minPayment", label: "Minimum monthly payment", type: "number", step: "0.01", value: existing.minPayment ?? "", half: true, chars: 8 },
      { name: "creditLimit", label: "Credit limit (cards)", type: "number", step: "0.01", value: existing.creditLimit ?? "" },
      { name: "notes", label: "Notes", value: existing.notes, placeholder: "Optional" },
    ],
    onSubmit: (v) => {
      // Valued assets: balance is always derived equity.
      if (VALUED_TYPES.includes(v.type)) {
        v.estValue = +v.estValue || 0;
        v.principalBalance = +v.principalBalance || 0;
        v.balance = v.estValue - v.principalBalance;
      }
      let created = null;
      mutate((s) => {
        if (existing.id) Object.assign(s.accounts.find((a) => a.id === existing.id), v);
        else {
          created = { id: uid(), ...v };
          s.accounts.push(created);
          if (created.type === "checking" && !s.settings.checkingAccountId) s.settings.checkingAccountId = created.id;
        }
      });
      toast(existing.id ? "Account updated" : "Account added");
      // New property assets: go straight to the details form (address / VIN),
      // deferred so formModal's closeModal doesn't wipe it.
      if (created?.type === "property") setTimeout(() => assetDetailsForm(created, "home"), 0);
      if (created?.type === "personal") setTimeout(() => assetDetailsForm(created, "vehicle"), 0);
      if (afterSave) afterSave();
    },
    onDelete: existing.id ? () => mutate((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== existing.id);
      if (s.settings.checkingAccountId === existing.id) s.settings.checkingAccountId = null;
    }) : null,
  });

  // Only show the fields that matter for the chosen type: valued assets get
  // estimated value + principal (balance is derived), debts get APR/payment
  // fields, and liquid accounts just get a balance.
  const typeSel = modal.querySelector('select[name="type"]');
  const setShown = (name, on, required = false) => {
    const input = modal.querySelector(`[name="${name}"]`);
    if (!input) return;
    // .field has its own display rule, so the hidden attribute wouldn't win
    input.closest("label").style.display = on ? "" : "none";
    input.required = on && required;
  };
  const syncFields = () => {
    const t = typeSel.value;
    const valued = VALUED_TYPES.includes(t);
    const debt = t === "credit" || t === "loan";
    const earns = t === "savings" || t === "investment" || t === "lifeins";
    setShown("balance", !valued, true);
    setShown("estValue", valued, true);
    setShown("principalBalance", valued);
    setShown("apr", debt || earns);
    setShown("minPayment", debt);
    setShown("creditLimit", t === "credit");
    // Same field, two meanings: debts are charged interest, savings earn it.
    const aprField = modal.querySelector('[name="apr"]').closest("label");
    aprField.querySelector("span").textContent = earns ? "Interest rate (APY % per year)" : "Interest rate (APR %)";
    const aprHint = aprField.querySelector(".form-hint");
    if (aprHint) aprHint.textContent = earns
      ? "What this account earns — it compounds monthly in the net-worth projection."
      : "For debts: the rate you're charged. Drives payoff plans.";
  };
  typeSel.addEventListener("change", syncFields);
  syncFields();
}

export function incomeForm(existing = {}, afterSave) {
  formModal({
    title: existing.id ? "Edit income" : "Add income",
    submitLabel: existing.id ? "Save" : "Add income",
    fields: [
      { name: "name", label: "Name", value: existing.name, required: true, placeholder: "e.g. Paycheck" },
      { name: "amount", label: "Amount per paycheck (take-home)", type: "number", step: "0.01", value: existing.amount, required: true, half: true },
      { name: "frequency", label: "How often", type: "select", value: existing.frequency || "biweekly", options: FREQUENCIES.filter((f) => f.id !== "once").map((f) => ({ value: f.id, label: f.label })), half: true },
      { name: "nextDate", label: "Next payday", type: "date", value: existing.nextDate || todayStr(), required: true },
      { name: "primary", label: "Primary income (defines pay periods for the budget forecast)", type: "checkbox", value: existing.primary ?? true },
    ],
    onSubmit: (v) => {
      mutate((s) => {
        if (v.primary) s.incomes.forEach((i) => (i.primary = false));
        if (existing.id) Object.assign(s.incomes.find((i) => i.id === existing.id), v);
        else s.incomes.push({ id: uid(), ...v });
        if (!s.incomes.some((i) => i.primary) && s.incomes.length) s.incomes[0].primary = true;
      });
      toast("Income saved");
      if (afterSave) afterSave();
    },
    onDelete: existing.id ? () => mutate((s) => { s.incomes = s.incomes.filter((i) => i.id !== existing.id); }) : null,
  });
}

export function budgetItemForm(existing = {}, afterSave) {
  formModal({
    title: existing.id ? "Edit spending category" : "Add spending category",
    submitLabel: "Save",
    fields: [
      { name: "name", label: "Category", value: existing.name, required: true, placeholder: "e.g. Groceries, Gas, Fun money" },
      { name: "amountPerMonth", label: "Planned amount per month", type: "number", step: "0.01", value: existing.amountPerMonth, required: true },
    ],
    onSubmit: (v) => {
      mutate((s) => {
        if (existing.id) Object.assign(s.budgetItems.find((i) => i.id === existing.id), v);
        else s.budgetItems.push({ id: uid(), ...v });
      });
      if (afterSave) afterSave();
    },
    onDelete: existing.id ? () => mutate((s) => { s.budgetItems = s.budgetItems.filter((i) => i.id !== existing.id); }) : null,
  });
}

// ---- Asset details: describe a property asset (vehicle etc.), decode a VIN,
// ---- and get an AI-estimated value the user can apply to the balance.

const CONDITIONS = ["Excellent", "Good", "Fair", "Poor"];

export function assetDetailsForm(account, defaultKind) {
  const d = account.details || {};
  const est = d.estimate;
  const kind0 = d.kind || defaultKind || "vehicle";
  const modal = openModal(`
    <h2>Asset details — ${esc(account.name)}</h2>
    <label class="field"><span>Asset type</span>
      <select id="ad-kind">
        <option value="vehicle" ${kind0 === "vehicle" ? "selected" : ""}>Vehicle</option>
        <option value="home" ${kind0 === "home" ? "selected" : ""}>Home / real estate</option>
        <option value="other" ${kind0 === "other" ? "selected" : ""}>Other (boat, equipment, collectible…)</option>
      </select></label>

    <div id="ad-home" hidden>
      <label class="field"><span>Street address</span>
        <input id="ad-address" value="${esc(d.address || "")}" placeholder="123 Main St, City, ST 12345"></label>
      <div class="form-hint">The AI estimate researches this address on the web (recent sales, Zestimate/Redfin, comps).</div>
      <div class="field-row" style="margin-top:10px">
        <label class="field"><span>Zillow Zestimate <a href="#" data-lookup="zillow zestimate">↗</a></span>
          <input id="ad-est-zillow" type="number" step="1" inputmode="numeric" value="${d.siteEstimates?.zillow || ""}" placeholder="0"></label>
        <label class="field"><span>Redfin Estimate <a href="#" data-lookup="redfin estimate">↗</a></span>
          <input id="ad-est-redfin" type="number" step="1" inputmode="numeric" value="${d.siteEstimates?.redfin || ""}" placeholder="0"></label>
        <label class="field"><span>Realtor.com value <a href="#" data-lookup="realtor.com home value">↗</a></span>
          <input id="ad-est-realtor" type="number" step="1" inputmode="numeric" value="${d.siteEstimates?.realtor || ""}" placeholder="0"></label>
      </div>
      <div class="form-hint">Optional, but makes the estimate far more accurate: these sites block automated lookups, so click ↗ to check each one yourself and paste the values. The AI anchors to them and tracks your local market from there — update them whenever you like.</div>
      <label class="field" style="display:flex;align-items:center;gap:8px;margin-top:10px">
        <input type="checkbox" id="ad-autoupdate" style="width:auto" ${d.autoUpdate === false ? "" : "checked"}>
        <span style="margin:0">Refresh the estimated value automatically every month</span></label>
    </div>

    <div id="ad-vehicle">
      <label class="field"><span>VIN (optional — fills in the details for you)</span>
        <div style="display:flex;gap:8px">
          <input id="ad-vin" value="${esc(d.vin || "")}" placeholder="17-character VIN" maxlength="17" style="text-transform:uppercase">
          <button class="btn" id="ad-vin-btn" type="button" style="white-space:nowrap">Look up</button>
        </div></label>
      <div class="field-row">
        <label class="field"><span>Year</span><input id="ad-year" inputmode="numeric" value="${esc(d.year || "")}" placeholder="2017"></label>
        <label class="field"><span>Make</span><input id="ad-make" value="${esc(d.make || "")}" placeholder="Chevrolet"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Model</span><input id="ad-model" value="${esc(d.model || "")}" placeholder="Silverado 1500"></label>
        <label class="field"><span>Trim</span><input id="ad-trim" value="${esc(d.trim || "")}" placeholder="LT, LTZ…"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Mileage</span><input id="ad-mileage" inputmode="numeric" value="${esc(d.mileage || "")}" placeholder="84,000"></label>
        <label class="field"><span>Condition</span>
          <select id="ad-condition">${CONDITIONS.map((c) => `<option ${d.condition === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      </div>
    </div>
    <div id="ad-other" hidden>
      <label class="field"><span>Description</span>
        <input id="ad-description" value="${esc(d.description || "")}" placeholder="e.g. 2019 Tracker 175 bass boat with trailer"></label>
      <label class="field"><span>Condition</span>
        <select id="ad-condition2">${CONDITIONS.map((c) => `<option ${d.condition === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    </div>
    <label class="field"><span>Notes for the appraisal (optional)</span>
      <input id="ad-notes" value="${esc(d.notes || "")}" placeholder="new tires, small dent on tailgate…"></label>
    <label class="field"><span>Principal balance remaining (optional)</span>
      <input id="ad-principal" type="number" step="0.01" inputmode="decimal" value="${account.principalBalance ?? ""}" placeholder="0"></label>
    <div class="form-hint">Mortgage or loan still owed on this asset. Net worth counts estimated value − principal.</div>

    <div id="ad-result">${est ? renderEstimate(est, account) : ""}</div>
    <div class="small muted" id="ad-ai-note" style="margin-top:8px"></div>

    <div class="modal-actions">
      <button class="btn" data-act="cancel" type="button">Cancel</button>
      <button class="btn" id="ad-estimate" type="button">✨ Estimate value with AI</button>
      <button class="btn btn-primary" id="ad-apply" type="button" hidden></button>
      <button class="btn btn-primary" id="ad-save" type="button">Save details</button>
    </div>
  `);

  const $ = (id) => modal.querySelector("#" + id);
  const kindSel = $("ad-kind");
  const syncKind = () => {
    $("ad-vehicle").hidden = kindSel.value !== "vehicle";
    $("ad-home").hidden = kindSel.value !== "home";
    $("ad-other").hidden = kindSel.value !== "other";
    if (kindSel.value === "home") $("ad-address").focus();
  };
  kindSel.addEventListener("change", syncKind);
  syncKind();

  // ↗ links: the estimate sites block automated lookups, so open a search for
  // the user to read the value themselves.
  modal.querySelectorAll("[data-lookup]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const addr = $("ad-address").value.trim();
      if (!addr) { toast("Enter the street address first"); $("ad-address").focus(); return; }
      window.open(`https://www.google.com/search?q=${encodeURIComponent(`${addr} ${a.dataset.lookup}`)}`, "_blank");
    })
  );

  // AI availability hint
  fetch("/api/ai-status").then((r) => r.json()).then(({ ai }) => {
    $("ad-ai-note").innerHTML = ai
      ? `VIN lookup uses the free U.S. NHTSA database; the AI estimate sends only these details (or, for homes, the address) to Anthropic's Claude API — home values are researched with web search. Everything else stays on this computer.`
      : `⚠ AI estimation needs an Anthropic API key: put one in <code>anthropic-key.txt</code> in the Finance Control folder (get a key at console.anthropic.com), then restart the server. VIN lookup works without it.`;
    if (!ai) $("ad-estimate").disabled = true;
  }).catch(() => {});

  const collectSiteEstimates = () => {
    const vals = {
      zillow: parseFloat($("ad-est-zillow").value) || 0,
      redfin: parseFloat($("ad-est-redfin").value) || 0,
      realtor: parseFloat($("ad-est-realtor").value) || 0,
    };
    const prev = d.siteEstimates || {};
    const changed = Object.keys(vals).some((k) => (prev[k] || 0) !== vals[k]);
    return { vals, date: changed ? todayStr() : d.siteEstimatesDate || todayStr() };
  };

  const collect = () => ({
    kind: kindSel.value,
    address: $("ad-address").value.trim(),
    siteEstimates: collectSiteEstimates().vals,
    siteEstimatesDate: collectSiteEstimates().date,
    autoUpdate: $("ad-autoupdate").checked,
    vin: $("ad-vin").value.trim().toUpperCase(),
    year: $("ad-year").value.trim(),
    make: $("ad-make").value.trim(),
    model: $("ad-model").value.trim(),
    trim: $("ad-trim").value.trim(),
    mileage: $("ad-mileage").value.trim(),
    condition: (kindSel.value === "other" ? $("ad-condition2") : $("ad-condition")).value,
    description: $("ad-description").value.trim(),
    notes: $("ad-notes").value.trim(),
    body: d.body || "", engine: d.engine || "", driveType: d.driveType || "",
    estimate: d.estimate || null,
  });

  const principalInput = () => parseFloat($("ad-principal").value) || 0;

  const saveDetails = (extra = {}) => {
    mutate((s) => {
      const a = s.accounts.find((x) => x.id === account.id);
      if (!a) return;
      a.details = { ...collect(), ...extra };
      a.principalBalance = principalInput();
      syncValuedBalance(a);
    });
  };

  $("ad-vin-btn").addEventListener("click", async () => {
    const vin = $("ad-vin").value.trim();
    if (vin.length < 11) { toast("Enter the full 17-character VIN"); return; }
    $("ad-vin-btn").disabled = true;
    $("ad-vin-btn").textContent = "Looking up…";
    try {
      const info = await (await fetch(`/api/vin-decode?vin=${encodeURIComponent(vin)}`)).json();
      if (info.error) toast(info.error);
      else {
        if (info.year) $("ad-year").value = info.year;
        if (info.make) $("ad-make").value = info.make;
        if (info.model) $("ad-model").value = info.model;
        if (info.trim) $("ad-trim").value = info.trim;
        d.body = info.body; d.engine = info.engine; d.driveType = info.driveType;
        toast(`VIN decoded: ${info.year} ${info.make} ${info.model}`.trim());
      }
    } catch { toast("VIN lookup failed — is the server online?"); }
    $("ad-vin-btn").disabled = false;
    $("ad-vin-btn").textContent = "Look up";
  });

  $("ad-estimate").addEventListener("click", async () => {
    const details = collect();
    const isHome = details.kind === "home";
    if (isHome && !details.address) { toast("Enter the street address first"); $("ad-address").focus(); return; }
    const btn = $("ad-estimate");
    btn.disabled = true;
    btn.textContent = isHome ? "Researching… (1–3 min)" : "Estimating… (10–30s)";
    try {
      const site = details.siteEstimates || {};
      const homePayload = {
        address: details.address,
        notes: details.notes,
        ...(Object.values(site).some((v) => v > 0)
          ? { site_estimates: { ...site, as_of: details.siteEstimatesDate } } : {}),
      };
      const res = await (await fetch(
        isHome ? "/api/estimate-home" : "/api/estimate-value",
        { method: "POST", body: JSON.stringify(isHome ? homePayload : details) }
      )).json();
      if (res.error === "no-key") toast("Add an Anthropic API key first — see the note below");
      else if (res.error) toast(res.error);
      else {
        d.estimate = res;
        $("ad-result").innerHTML = renderEstimate(res, account, collect());
        wireUseValue();
        syncApply();
        saveDetails({ estimate: res });
        toast(`Estimated: ${fmtMoney(res.estimated_value)}`);
      }
    } catch { toast("Estimate failed — is the server online?"); }
    btn.disabled = false;
    btn.textContent = "✨ Estimate value with AI";
  });

  // Apply the estimate: it fills the account's estimated-value field, and the
  // balance becomes the derived equity (estimated value − principal).
  const applyEstimate = () => {
    const est2 = d.estimate;
    if (!est2) return;
    const details = collect();
    const principal = principalInput();
    mutate((s) => {
      const a = s.accounts.find((x) => x.id === account.id);
      if (!a) return;
      a.estValue = est2.estimated_value;
      a.principalBalance = principal;
      a.details = { ...details, estimate: est2 };
      syncValuedBalance(a);
    });
    closeModal();
    toast(principal
      ? `${account.name}: value ${fmtMoney(est2.estimated_value)} − ${fmtMoney(principal)} principal = ${fmtMoney(est2.estimated_value - principal)} equity`
      : `${account.name} estimated value set to ${fmtMoney(est2.estimated_value)}`);
    render();
  };

  // Always-visible apply button in the action row, labeled with the live amount.
  const applyBtn = $("ad-apply");
  applyBtn.addEventListener("click", applyEstimate);
  const syncApply = () => {
    if (!d.estimate) { applyBtn.hidden = true; return; }
    applyBtn.hidden = false;
    applyBtn.textContent = `${principalInput() > 0 ? "Use equity" : "Use value"} — ${fmtMoney(appliedValue(d.estimate, principalInput()))}`;
  };
  syncApply();

  const wireUseValue = () => {
    modal.querySelector("#ad-use-value")?.addEventListener("click", applyEstimate);
  };
  wireUseValue();

  // Editing the principal updates the equity shown on the estimate card and
  // the apply button.
  $("ad-principal").addEventListener("input", () => {
    syncApply();
    if (!d.estimate) return;
    $("ad-result").innerHTML = renderEstimate(d.estimate, account, principalInput());
    wireUseValue();
  });
  kindSel.addEventListener("change", syncApply);

  $("ad-save").addEventListener("click", () => { saveDetails(); closeModal(); toast("Details saved"); render(); });
  modal.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
}

// The equity the estimate produces: estimated value minus any loan principal
// still owed on the asset.
function appliedValue(est, principal) {
  return est.estimated_value - (+principal || 0);
}

function renderEstimate(est, account, principalOverride) {
  const principal = +(principalOverride ?? account.principalBalance) || 0;
  const applied = appliedValue(est, principal);
  const cur = +account.estValue || 0;
  return `
    <div class="card" style="background:var(--wash);border-left:3px solid var(--series-1);margin-top:4px">
      <div class="stat-label">AI estimated value <span class="muted">· ${esc(est.date || "")} · confidence: ${esc(est.confidence || "—")}</span></div>
      <div class="stat-value">${fmtMoney(est.estimated_value)} <span class="muted small" style="font-weight:400">range ${fmtMoney(est.low)} – ${fmtMoney(est.high)}</span></div>
      ${principal ? `<div class="small" style="margin-top:4px">− ${fmtMoney(principal)} principal remaining = <b>${fmtMoney(applied)}</b> equity</div>` : ""}
      <div class="small" style="margin-top:6px">${esc(est.explanation || "")}</div>
      <div class="section-gap">
        <button class="btn btn-primary btn-sm" id="ad-use-value" type="button">Use ${principal ? "equity" : "this value"} — ${fmtMoney(applied)}${cur ? ` (estimated value replaces ${fmtMoney(cur)})` : ""}</button>
      </div>
    </div>`;
}

export function renderAccounts(main) {
  const s = getState();
  const nw = netWorth();
  const assets = s.accounts.filter((a) => !isDebt(a));
  const liabilities = s.accounts.filter(isDebt);
  const typeLabel = (t) => ACCOUNT_TYPES.find((x) => x.id === t)?.label || t;

  // Debts with a balance but no bill linked to them — their payments are
  // missing from Bills, so forecasts and payoff plans would be wrong.
  const bills = activeBills();
  const needsBill = (a) => isDebt(a) && (+a.balance || 0) > 0.01 && !bills.some((b) => b.linkedAccountId === a.id);

  const detailsSummary = (a) => {
    const dt = a.details;
    if (!dt) return "";
    const bits = [dt.year, dt.make, dt.model, dt.trim].filter(Boolean).join(" ") || dt.description || dt.address || "";
    const mi = dt.mileage ? ` · ${esc(dt.mileage)} mi` : "";
    return bits ? ` · ${esc(bits)}${mi}` : "";
  };
  // Credit cards above the utilization threshold are flagged red; the Card
  // Paydown page shows the payment that clears it.
  const overUtil = (a) => (cardUtilization(a) ?? 0) > CARD_UTIL_THRESHOLD;
  const acctRow = (a) => `
    <tr class="clickable" data-acct="${a.id}">
      <td><div class="list-title">${esc(a.name)}
            ${needsBill(a) ? `<button class="pill soon" data-add-bill="${a.id}" type="button" title="This debt has a balance but no bill linked to it — click to add its payment so it's included in forecasts and payoff plans"><span class="dot" style="background:var(--status-warning)"></span>no bill — add</button>` : ""}
            ${overUtil(a) ? `<a class="pill overdue" href="#cards" title="Over ${CARD_UTIL_THRESHOLD * 100}% of its credit limit — see Card Paydown for the payment that fixes it"><span class="dot" style="background:var(--status-critical)"></span>${Math.round(cardUtilization(a) * 100)}% of limit</a>` : ""}
          </div><div class="small muted">${esc(typeLabel(a.type))}${a.id === s.settings.checkingAccountId ? " · forecast account" : ""}${detailsSummary(a)}${
            a.estValue != null && +a.principalBalance > 0
              ? ` · ${fmtMoney(+a.estValue)} value − ${fmtMoney(+a.principalBalance)} principal`
              : ""}</div></td>
      <td class="num"><b class="${overUtil(a) ? "neg" : ""}">${fmtMoney(+a.balance)}</b></td>
      <td class="num">${a.apr ? fmtPct(a.apr) : '<span class="muted">—</span>'}</td>
      <td class="num">${a.minPayment ? fmtMoney(+a.minPayment) : '<span class="muted">—</span>'}</td>
      <td class="num">${a.type === "property" || a.type === "personal" ? `<button class="btn btn-sm" data-details="${a.id}">Details</button>` : ""}</td>
    </tr>`;

  main.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Accounts &amp; Income</div>
        <div class="view-sub">Assets ${fmtMoney(nw.assets)} · Debts ${fmtMoney(nw.liabilities)} · Net worth <b>${fmtMoney(nw.net)}</b></div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="add-income">+ Income</button>
        <button class="btn btn-primary" id="add-account">+ Account</button>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-title">Assets</div>
        ${assets.length ? `<div class="table-scroll"><table class="data">
          <thead><tr><th>Account</th><th class="num">Balance</th><th class="num">Rate</th><th class="num">Min pmt</th><th></th></tr></thead>
          <tbody>${assets.map(acctRow).join("")}</tbody></table></div>`
        : `<div class="muted small">Add your checking, savings, and investment accounts. Property assets (vehicles, boats…) get a Details button with VIN lookup and AI valuation.</div>`}
      </div>
      <div class="card">
        <div class="card-title">Debts</div>
        ${liabilities.length ? `<div class="table-scroll"><table class="data">
          <thead><tr><th>Account</th><th class="num">Balance</th><th class="num">APR</th><th class="num">Min pmt</th><th></th></tr></thead>
          <tbody>${liabilities.map(acctRow).join("")}</tbody></table></div>`
        : `<div class="muted small">Add credit cards and loans with their APRs — the payoff planner uses them.</div>`}
      </div>
    </div>

    <div class="grid cols-2 section-gap">
      <div class="card">
        <div class="card-title">Income <span class="hint">take-home pay</span></div>
        ${s.incomes.length ? s.incomes.map((i) => `
          <div class="list-row clickable" data-income="${i.id}" style="cursor:pointer">
            <div class="list-main">
              <div class="list-title">${esc(i.name)} ${i.primary ? '<span class="pill ok">primary</span>' : ""}</div>
              <div class="list-sub">${esc(freqLabel(i.frequency))} · next payday ${fmtDate(i.nextDate)}</div>
            </div>
            <div class="list-amount pos">+${fmtMoney(+i.amount)}</div>
          </div>`).join("")
        : `<div class="muted small">Add your paycheck so the budget can forecast each pay period.</div>`}
        <div class="small muted section-gap">≈ ${fmtMoney(sum(s.incomes, (i) => monthlyAmount(+i.amount || 0, i.frequency)))} per month</div>
      </div>

      <div class="card">
        <div class="card-title">Planned monthly spending <span class="hint">outside of bills</span>
        </div>
        ${s.budgetItems.length ? s.budgetItems.map((i) => `
          <div class="list-row clickable" data-budget="${i.id}" style="cursor:pointer">
            <div class="list-main"><div class="list-title">${esc(i.name)}</div></div>
            <div class="list-amount">${fmtMoney(+i.amountPerMonth)}<span class="muted small">/mo</span></div>
          </div>`).join("")
        : `<div class="muted small">Groceries, gas, dining out — day-to-day spending that isn't a fixed bill. The forecast spreads it across pay periods.</div>`}
        <div class="section-gap"><button class="btn btn-sm" id="add-budget-item">+ Add category</button></div>
      </div>
    </div>

    <div class="card section-gap">
      <div class="card-title">Forecast settings</div>
      <div class="field-row">
        <label class="field"><span>Spending account (balance used in forecasts)</span>
          <select id="set-checking">${s.accounts.filter((a) => !isDebt(a)).map((a) => `<option value="${a.id}" ${a.id === s.settings.checkingAccountId ? "selected" : ""}>${esc(a.name)}</option>`).join("") || '<option value="">— add a checking account —</option>'}</select>
        </label>
        <label class="field"><span>Bill reminder window (days)</span>
          <input id="set-reminder" type="number" min="1" max="60" value="${s.settings.reminderDays || 10}">
        </label>
        <label class="field"><span>Default savings/investment growth (% per year) — used when an account has no interest rate of its own</span>
          <input id="set-growth" type="number" step="0.1" value="${s.settings.savingsGrowthPct || 0}">
        </label>
      </div>
    </div>
  `;

  main.querySelector("#add-account").addEventListener("click", () => accountForm());
  main.querySelector("#add-income").addEventListener("click", () => incomeForm());
  main.querySelector("#add-budget-item").addEventListener("click", () => budgetItemForm({}, render));
  main.querySelectorAll("[data-acct]").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest("a")) return;
    accountForm(s.accounts.find((a) => a.id === tr.dataset.acct));
  }));
  main.querySelectorAll("[data-details]").forEach((btn) => btn.addEventListener("click", () =>
    assetDetailsForm(s.accounts.find((a) => a.id === btn.dataset.details))));
  // "no bill" pill → Add-bill form prefilled for that debt
  main.querySelectorAll("[data-add-bill]").forEach((btn) => btn.addEventListener("click", () => {
    const a = s.accounts.find((x) => x.id === btn.dataset.addBill);
    billForm({ name: a.name, amount: a.minPayment || "", category: "Debt", linkedAccountId: a.id }, render);
  }));
  main.querySelectorAll("[data-income]").forEach((el) => el.addEventListener("click", () => incomeForm(s.incomes.find((i) => i.id === el.dataset.income))));
  main.querySelectorAll("[data-budget]").forEach((el) => el.addEventListener("click", () => budgetItemForm(s.budgetItems.find((i) => i.id === el.dataset.budget), render)));

  main.querySelector("#set-checking").addEventListener("change", (e) => mutate((st) => { st.settings.checkingAccountId = e.target.value; }));
  main.querySelector("#set-reminder").addEventListener("change", (e) => mutate((st) => { st.settings.reminderDays = Math.max(1, parseInt(e.target.value) || 10); }));
  main.querySelector("#set-growth").addEventListener("change", (e) => mutate((st) => { st.settings.savingsGrowthPct = parseFloat(e.target.value) || 0; }));
}
