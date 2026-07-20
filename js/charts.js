// Minimal SVG chart engine: line charts (with crosshair + tooltip),
// bar charts (per-mark hover), and sparklines. No dependencies.

import { fmtMoneyCompact, fmtMoney, clamp, esc } from "./utils.js";

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

// Shared floating tooltip
let tipEl = null;
function tooltip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "chart-tooltip";
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
export function showTip(html, x, y) {
  const t = tooltip();
  t.innerHTML = html;
  t.style.display = "block";
  const r = t.getBoundingClientRect();
  const left = clamp(x + 14, 8, window.innerWidth - r.width - 8);
  const top = clamp(y - r.height - 10, 8, window.innerHeight - r.height - 8);
  t.style.left = left + "px";
  t.style.top = top + "px";
}
export function hideTip() {
  if (tipEl) tipEl.style.display = "none";
}

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 1.5 ? 2.5 : norm >= 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

/**
 * Line chart.
 * opts: { series: [{name, color, values:[{x(label), y}]}], height, money, fillFirst }
 * All series share the same x categories (values arrays align by index).
 */
export function lineChart(container, opts) {
  const { series, height = 220, money = true, fillFirst = false } = opts;
  container.innerHTML = "";
  if (!series.length || !series[0].values.length) {
    container.innerHTML = `<div class="chart-empty">No data yet</div>`;
    return;
  }
  const W = Math.max(320, container.clientWidth || 560);
  const H = height;
  const pad = { l: 52, r: 16, t: 12, b: 26 };
  const n = series[0].values.length;
  const allY = series.flatMap((s) => s.values.map((v) => v.y));
  let yMin = Math.min(...allY), yMax = Math.max(...allY);
  if (yMin > 0) yMin = 0;
  const ticks = niceTicks(yMin, yMax);
  yMin = ticks[0]; yMax = ticks[ticks.length - 1];
  const xAt = (i) => pad.l + (n === 1 ? 0 : (i * (W - pad.l - pad.r)) / (n - 1));
  const yAt = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" });

  // gridlines + y labels
  for (const t of ticks) {
    svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: yAt(t), y2: yAt(t), class: t === 0 ? "axis-line" : "grid-line" }));
    const lbl = el("text", { x: pad.l - 8, y: yAt(t) + 3.5, class: "tick-label", "text-anchor": "end" });
    lbl.textContent = money ? fmtMoneyCompact(t) : t.toLocaleString();
    svg.appendChild(lbl);
  }
  // x labels (thinned)
  const every = Math.ceil(n / Math.floor((W - pad.l - pad.r) / 64));
  series[0].values.forEach((v, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    const lbl = el("text", { x: xAt(i), y: H - 8, class: "tick-label", "text-anchor": i === n - 1 ? "end" : "middle" });
    lbl.textContent = v.x;
    svg.appendChild(lbl);
  });

  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => [xAt(i), yAt(v.y)]);
    if (fillFirst && si === 0) {
      const d = `M ${pts.map((p) => p.join(",")).join(" L ")} L ${pts[pts.length - 1][0]},${yAt(Math.max(0, yMin))} L ${pts[0][0]},${yAt(Math.max(0, yMin))} Z`;
      svg.appendChild(el("path", { d, fill: s.color, opacity: 0.1, stroke: "none" }));
    }
    svg.appendChild(el("path", {
      d: `M ${pts.map((p) => p.join(",")).join(" L ")}`,
      fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
      ...(s.dashed ? { "stroke-dasharray": "5 4" } : {}),
    }));
    // end marker + ring
    const last = pts[pts.length - 1];
    svg.appendChild(el("circle", { cx: last[0], cy: last[1], r: 6, class: "marker-ring" }));
    svg.appendChild(el("circle", { cx: last[0], cy: last[1], r: 4, fill: s.color }));
  });

  // crosshair + hover layer
  const cross = el("line", { y1: pad.t, y2: H - pad.b, class: "crosshair", style: "display:none" });
  svg.appendChild(cross);
  const dots = series.map((s) => {
    const ring = el("circle", { r: 6, class: "marker-ring", style: "display:none" });
    const dot = el("circle", { r: 4, fill: s.color, style: "display:none" });
    svg.appendChild(ring); svg.appendChild(dot);
    return { ring, dot };
  });
  const overlay = el("rect", { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b, fill: "transparent" });
  svg.appendChild(overlay);

  const fmt = money ? fmtMoney : (v) => v.toLocaleString();
  overlay.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const scale = W / rect.width;
    const mx = (ev.clientX - rect.left) * scale;
    const i = clamp(Math.round(((mx - pad.l) / (W - pad.l - pad.r)) * (n - 1)), 0, n - 1);
    const x = xAt(i);
    cross.setAttribute("x1", x); cross.setAttribute("x2", x);
    cross.style.display = "";
    let rows = "";
    series.forEach((s, si) => {
      const v = s.values[i];
      dots[si].ring.setAttribute("cx", x); dots[si].ring.setAttribute("cy", yAt(v.y)); dots[si].ring.style.display = "";
      dots[si].dot.setAttribute("cx", x); dots[si].dot.setAttribute("cy", yAt(v.y)); dots[si].dot.style.display = "";
      rows += `<div class="tip-row"><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}<b>${fmt(v.y)}</b></div>`;
    });
    showTip(`<div class="tip-title">${esc(series[0].values[i].xFull || series[0].values[i].x)}</div>${rows}`, ev.clientX, ev.clientY);
  });
  overlay.addEventListener("mouseleave", () => {
    cross.style.display = "none";
    dots.forEach((d) => { d.ring.style.display = "none"; d.dot.style.display = "none"; });
    hideTip();
  });

  container.appendChild(svg);

  // legend (only for 2+ series)
  if (series.length > 1) {
    const legend = document.createElement("div");
    legend.className = "chart-legend";
    legend.innerHTML = series.map((s) => `<span class="legend-item"><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("");
    container.appendChild(legend);
  }
}

/**
 * Horizontal bar list (label + bar + value). Good for category breakdowns.
 * items: [{label, value, color, sub}]
 */
export function barList(container, items, { money = true, max = null, suffix = "" } = {}) {
  container.innerHTML = "";
  if (!items.length) {
    container.innerHTML = `<div class="chart-empty">No data yet</div>`;
    return;
  }
  const top = max ?? Math.max(...items.map((i) => Math.abs(i.value)));
  const wrap = document.createElement("div");
  wrap.className = "bar-list";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const pct = top ? Math.max(1.5, (Math.abs(it.value) / top) * 100) : 0;
    row.innerHTML = `
      <div class="bar-row-label" title="${esc(it.label)}">${esc(it.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${it.color}"></div></div>
      <div class="bar-row-value">${money ? fmtMoney(it.value) : it.value.toLocaleString() + suffix}</div>`;
    if (it.sub) row.title = it.sub;
    row.addEventListener("mousemove", (ev) => showTip(`<div class="tip-title">${esc(it.label)}</div><div class="tip-row"><b>${money ? fmtMoney(it.value) : it.value + suffix}</b></div>${it.sub ? `<div class="tip-sub">${esc(it.sub)}</div>` : ""}`, ev.clientX, ev.clientY));
    row.addEventListener("mouseleave", hideTip);
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

/** Vertical column chart (months on x). cols: [{x, y, color, tip}] */
export function columnChart(container, cols, { height = 180, money = true } = {}) {
  container.innerHTML = "";
  if (!cols.length) {
    container.innerHTML = `<div class="chart-empty">No data yet</div>`;
    return;
  }
  const W = Math.max(320, container.clientWidth || 560);
  const H = height;
  const pad = { l: 52, r: 8, t: 12, b: 24 };
  const yMax0 = Math.max(...cols.map((c) => c.y), 1);
  const ticks = niceTicks(0, yMax0, 3);
  const yMax = ticks[ticks.length - 1];
  const innerW = W - pad.l - pad.r;
  const slot = innerW / cols.length;
  const barW = Math.min(24, slot * 0.6);
  const yAt = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" });
  for (const t of ticks) {
    svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: yAt(t), y2: yAt(t), class: t === 0 ? "axis-line" : "grid-line" }));
    const lbl = el("text", { x: pad.l - 8, y: yAt(t) + 3.5, class: "tick-label", "text-anchor": "end" });
    lbl.textContent = money ? fmtMoneyCompact(t) : t.toLocaleString();
    svg.appendChild(lbl);
  }
  cols.forEach((c, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const y = yAt(c.y);
    const h = Math.max(0, yAt(0) - y);
    const r = Math.min(4, h);
    const path = `M ${cx - barW / 2},${yAt(0)} L ${cx - barW / 2},${y + r} Q ${cx - barW / 2},${y} ${cx - barW / 2 + r},${y} L ${cx + barW / 2 - r},${y} Q ${cx + barW / 2},${y} ${cx + barW / 2},${y + r} L ${cx + barW / 2},${yAt(0)} Z`;
    const bar = el("path", { d: path, fill: c.color });
    svg.appendChild(bar);
    const hit = el("rect", { x: pad.l + slot * i, y: pad.t, width: slot, height: H - pad.t - pad.b, fill: "transparent" });
    hit.addEventListener("mousemove", (ev) => showTip(c.tip || `<div class="tip-title">${esc(c.x)}</div><div class="tip-row"><b>${money ? fmtMoney(c.y) : c.y}</b></div>`, ev.clientX, ev.clientY));
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);
    if (cols.length <= 15) {
      const lbl = el("text", { x: cx, y: H - 8, class: "tick-label", "text-anchor": "middle" });
      lbl.textContent = c.x;
      svg.appendChild(lbl);
    }
  });
  container.appendChild(svg);
}

/** Tiny sparkline for stat tiles. */
export function sparkline(container, values, color) {
  container.innerHTML = "";
  if (values.length < 2) return;
  const W = 96, H = 28, p = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const xAt = (i) => p + (i * (W - 2 * p)) / (values.length - 1);
  const yAt = (v) => p + (1 - (v - min) / (max - min || 1)) * (H - 2 * p);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "sparkline" });
  svg.appendChild(el("path", {
    d: `M ${values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" L ")}`,
    fill: "none", stroke: color, "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
  }));
  const last = values.length - 1;
  svg.appendChild(el("circle", { cx: xAt(last), cy: yAt(values[last]), r: 3, fill: color }));
  container.appendChild(svg);
}
