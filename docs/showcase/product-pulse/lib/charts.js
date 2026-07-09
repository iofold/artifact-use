// Tiny dependency-free SVG chart helpers for Product Pulse.
// Each function renders into a host element and wires hover tooltips against
// the single shared .tip element.
"use strict";

const tipEl = () => document.getElementById("tip");
const fmt = (n) =>
  Math.abs(n) >= 1000
    ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : String(Math.round(n * 10) / 10);

function showTip(e, html) {
  const t = tipEl();
  t.innerHTML = html;
  t.style.display = "block";
  const pad = 14;
  const w = t.offsetWidth;
  const x = Math.min(e.clientX + pad, innerWidth - w - 8);
  t.style.left = x + "px";
  t.style.top = e.clientY - 12 - t.offsetHeight + "px";
}
function hideTip() {
  tipEl().style.display = "none";
}

// Multi-series line chart with crosshair hover.
// series: [{ key, label, color, values: number[] }], labels: string[] (x)
export function lineChart(host, labels, series, { height = 260 } = {}) {
  const W = Math.max(620, Math.min(1080, host.clientWidth || 900));
  const H = height;
  const P = { l: 52, r: 14, t: 12, b: 30 };
  const visible = series.filter((s) => !s.hidden);
  const maxV = Math.max(1, ...visible.flatMap((s) => s.values));
  const sx = (i) =>
    P.l + (i / Math.max(1, labels.length - 1)) * (W - P.l - P.r);
  const sy = (v) => H - P.b - (v / maxV) * (H - P.t - P.b);
  let inner = "";
  for (const frac of [0, 0.5, 1]) {
    const y = sy(maxV * frac);
    inner += `<line x1="${P.l}" y1="${y}" x2="${W - P.r}" y2="${y}" stroke="var(--line-soft)" ${frac ? 'stroke-dasharray="3 3"' : ""}/>`;
    inner += `<text x="${P.l - 6}" y="${y + 3}" text-anchor="end">${fmt(maxV * frac)}</text>`;
  }
  const step = Math.ceil(labels.length / 7);
  labels.forEach((lab, i) => {
    if (i % step === 0 || i === labels.length - 1)
      inner += `<text x="${sx(i)}" y="${H - P.b + 16}" text-anchor="middle">${lab.slice(5)}</text>`;
  });
  for (const s of visible) {
    const path = s.values
      .map((v, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`)
      .join("");
    inner += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
    const area =
      path +
      `L${sx(s.values.length - 1).toFixed(1)},${H - P.b}L${sx(0).toFixed(1)},${H - P.b}Z`;
    inner += `<path d="${area}" fill="${s.color}" opacity="0.06"/>`;
  }
  inner += `<line id="xh" x1="0" y1="${P.t}" x2="0" y2="${H - P.b}" stroke="var(--muted)" stroke-dasharray="2 3" opacity="0"/>`;
  inner += `<rect x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent" id="hover-net"/>`;
  host.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Daily metrics">${inner}</svg>`;
  const svg = host.querySelector("svg");
  const net = svg.querySelector("#hover-net");
  const xh = svg.querySelector("#xh");
  net.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = Math.round(((x - P.l) / (W - P.l - P.r)) * (labels.length - 1));
    if (i < 0 || i >= labels.length) return;
    xh.setAttribute("x1", sx(i));
    xh.setAttribute("x2", sx(i));
    xh.setAttribute("opacity", "1");
    showTip(
      e,
      `<b>${labels[i]}</b><br>` +
        visible
          .map((s) => `${s.label}: <b>${fmt(s.values[i])}</b>`)
          .join("<br>"),
    );
  });
  net.addEventListener("mouseleave", () => {
    xh.setAttribute("opacity", "0");
    hideTip();
  });
}

// Donut chart. items: [{label, value}]
export function donut(host, items, colors) {
  const total = items.reduce((s, d) => s + d.value, 0) || 1;
  const R = 74,
    r = 46,
    C = 88;
  let a0 = -Math.PI / 2;
  let paths = "";
  items.forEach((d, i) => {
    const a1 = a0 + (d.value / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p0 = [C + R * Math.cos(a0), C + R * Math.sin(a0)];
    const p1 = [C + R * Math.cos(a1), C + R * Math.sin(a1)];
    const q1 = [C + r * Math.cos(a1), C + r * Math.sin(a1)];
    const q0 = [C + r * Math.cos(a0), C + r * Math.sin(a0)];
    paths += `<path data-i="${i}" d="M${p0}A${R},${R} 0 ${large} 1 ${p1}L${q1}A${r},${r} 0 ${large} 0 ${q0}Z" fill="${colors[i % colors.length]}" opacity="0.9"/>`;
    a0 = a1;
  });
  host.innerHTML =
    `<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">` +
    `<svg width="176" height="176" role="img">${paths}<text x="${C}" y="${C + 4}" text-anchor="middle" style="font:600 15px var(--serif);fill:var(--ink)">${fmt(total)}%</text></svg>` +
    `<ul style="list-style:none;margin:0;padding:0;font-size:13px">` +
    items
      .map(
        (d, i) =>
          `<li style="margin-bottom:6px"><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${colors[i % colors.length]};margin-right:7px"></i>${d.label} <b style="font-variant-numeric:tabular-nums">${d.value}%</b></li>`,
      )
      .join("") +
    `</ul></div>`;
  host.querySelectorAll("path").forEach((p) => {
    p.addEventListener("mousemove", (e) => {
      const d = items[+p.dataset.i];
      showTip(e, `${d.label}: <b>${d.value}%</b>`);
      p.setAttribute("opacity", "1");
    });
    p.addEventListener("mouseleave", () => {
      hideTip();
      p.setAttribute("opacity", "0.9");
    });
  });
}

// Horizontal bar list. items: [{label, value}]
export function barList(host, items, color) {
  const max = Math.max(...items.map((d) => d.value), 1);
  host.innerHTML = items
    .map(
      (d) => `
    <div style="margin-bottom:9px">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px">
        <span>${d.label}</span><b style="font-variant-numeric:tabular-nums">${d.value}%</b>
      </div>
      <div style="height:9px;border-radius:5px;background:var(--line-soft)">
        <div style="height:9px;border-radius:5px;background:${color};width:${(d.value / max) * 100}%"></div>
      </div>
    </div>`,
    )
    .join("");
}
