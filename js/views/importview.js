// Import: upload a bank/card statement CSV, detect recurring bills, keep transactions.

import { getState, mutate, activeBills } from "../store.js";
import { parseCSV, normalizeStatement, parseStatementLines, detectRecurring, normalizeMerchant } from "../engine.js";
import { columnChart } from "../charts.js";
import { render, toast } from "../app.js";
import { esc, fmtMoney, fmtDate, freqLabel, titleCase, uid, sum, todayStr, parseYMD } from "../utils.js";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let pendingSuggestions = null; // survives re-render within this view visit

export function renderImport(main) {
  const s = getState();

  main.innerHTML = `
    <div class="view-head">
      <div>
        <div class="view-title">Import Statement</div>
        <div class="view-sub">Upload a CSV export from your bank or card. It's read right here in your browser — never uploaded anywhere.</div>
      </div>
      ${s.transactions.length ? `<button class="btn btn-ghost btn-danger btn-sm" id="clear-tx">Clear imported transactions</button>` : ""}
    </div>

    <div class="dropzone" id="dropzone">
      <div class="big">Drop a CSV or PDF statement here</div>
      <div>or click to choose a file · most banks: Account → Statements/Documents → Download</div>
      <input type="file" id="csv-input" accept=".csv,text/csv,.pdf,application/pdf" hidden>
    </div>

    <div id="suggestions"></div>

    ${s.transactions.length ? `
    <div class="card section-gap">
      <div class="card-title">Monthly spending from imported transactions <span class="hint">${s.transactions.length} transactions on file</span></div>
      <div id="chart-monthly"></div>
    </div>
    <div class="card section-gap">
      <div class="card-title">Recent transactions</div>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${[...s.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20).map((t) => `
            <tr><td class="muted">${fmtDate(t.date)}</td><td>${esc(t.description)}</td>
            <td class="num ${t.amount >= 0 ? "pos" : ""}">${t.amount >= 0 ? "+" : ""}${fmtMoney(t.amount)}</td></tr>`).join("")}
        </tbody>
      </table></div>
    </div>` : ""}
  `;

  const dz = document.getElementById("dropzone");
  const input = document.getElementById("csv-input");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); dz.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f, main);
  });
  input.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0], main); e.target.value = ""; });

  document.getElementById("clear-tx")?.addEventListener("click", () => {
    if (!confirm("Remove all imported transactions? (Bills you've added are kept.)")) return;
    mutate((st) => { st.transactions = []; });
    render();
  });

  if (pendingSuggestions) showSuggestions(main, pendingSuggestions);
  if (s.transactions.length) drawMonthly(s.transactions);
}

async function handleFile(file, main) {
  const isPDF = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  let transactions;
  try {
    if (isPDF) {
      transactions = await parsePDFFile(file);
      if (transactions === null) return; // error already shown
    } else {
      const rows = parseCSV(await file.text());
      transactions = normalizeStatement(rows).transactions;
    }
  } catch {
    toast("Couldn't read that file");
    return;
  }
  if (!transactions.length) {
    toast(isPDF
      ? "No transactions found in that PDF — if it's a scanned image, try the CSV export instead"
      : "No transactions found — is this a CSV with date and amount columns?");
    return;
  }

  // merge, de-duping on (date, description, amount)
  let added = 0;
  mutate((s) => {
    const seen = new Set(s.transactions.map((t) => `${t.date}|${t.description}|${t.amount}`));
    for (const t of transactions) {
      const key = `${t.date}|${t.description}|${t.amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      s.transactions.push({ id: uid(), source: file.name, ...t });
      added++;
    }
  });

  const all = getState().transactions;
  const suggestions = detectRecurring(all);
  // hide ones already tracked as bills (rough name match)
  const existingNames = new Set(activeBills().map((b) => normalizeMerchant(b.name)));
  pendingSuggestions = suggestions.filter((sg) => !existingNames.has(normalizeMerchant(sg.merchant)) && !sg.dismissed);

  toast(`Imported ${added} new transaction${added === 1 ? "" : "s"} from ${file.name}`);
  render();
}

// Send the PDF to the local server for text extraction, then parse the lines.
async function parsePDFFile(file) {
  const buf = await file.arrayBuffer();
  let payload;
  try {
    const res = await fetch("/api/parse-pdf", { method: "POST", body: buf });
    payload = await res.json();
  } catch {
    toast("Couldn't reach the local server to read the PDF");
    return null;
  }
  if (payload.error === "encrypted") {
    toast("That PDF is password-protected — export an unlocked copy or use CSV");
    return null;
  }
  if (payload.error || !payload.lines) {
    toast("Couldn't read that PDF — try the CSV export instead");
    return null;
  }
  return parseStatementLines(payload.lines);
}

function showSuggestions(main, suggestions) {
  const box = main.querySelector("#suggestions");
  if (!suggestions.length) {
    box.innerHTML = `<div class="card section-gap"><div class="card-title">Recurring bill detection</div>
      <div class="muted small">No new recurring charges detected yet. Import a statement covering 2–3 months for best results — detection needs at least two occurrences of a charge.</div></div>`;
    return;
  }
  box.innerHTML = `
    <div class="card section-gap" style="border-left:3px solid var(--series-1)">
      <div class="card-title">Looks recurring — add as bills? <span class="hint">${suggestions.length} found</span></div>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Merchant</th><th class="num">Amount</th><th>Pattern</th><th>Next expected</th><th></th></tr></thead>
        <tbody>
          ${suggestions.map((sg, i) => `
            <tr>
              <td><div class="list-title">${esc(titleCase(sg.merchant))}</div>
                  <div class="small muted">seen ${sg.count}× · last ${fmtDate(sg.lastDate)}</div></td>
              <td class="num"><b>${fmtMoney(sg.avgAmount)}</b>${sg.variable ? '<div class="small muted">varies</div>' : ""}</td>
              <td>${esc(freqLabel(sg.frequency))}</td>
              <td>${fmtDate(sg.nextDue)}</td>
              <td class="num" style="white-space:nowrap">
                <button class="btn btn-sm btn-primary" data-accept="${i}">Add bill</button>
                <button class="btn btn-sm btn-ghost" data-dismiss="${i}">Ignore</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table></div>
    </div>`;

  box.querySelectorAll("[data-accept]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const sg = suggestions[+btn.dataset.accept];
      mutate((s) => {
        s.bills.push({
          id: uid(), name: titleCase(sg.merchant), amount: sg.avgAmount,
          frequency: sg.frequency, nextDue: sg.nextDue, category: "Subscriptions",
          autopay: true, active: true,
          notes: `Detected from statement (${sg.count} charges, e.g. "${sg.sampleDescription}")`,
        });
      });
      pendingSuggestions = suggestions.filter((x) => x !== sg);
      toast(`Added ${titleCase(sg.merchant)} as a bill`);
      render();
    })
  );
  box.querySelectorAll("[data-dismiss]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const sg = suggestions[+btn.dataset.dismiss];
      pendingSuggestions = suggestions.filter((x) => x !== sg);
      render();
    })
  );
}

function drawMonthly(transactions) {
  const byMonth = {};
  for (const t of transactions) {
    if (t.amount >= 0) continue;
    const m = t.date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + Math.abs(t.amount);
  }
  const months = Object.keys(byMonth).sort().slice(-12);
  columnChart(document.getElementById("chart-monthly"),
    months.map((m) => ({
      x: parseYMD(m + "-01").toLocaleDateString("en-US", { month: "short" }),
      y: Math.round(byMonth[m]),
      color: css("--series-1"),
    })), { height: 190 });
}
