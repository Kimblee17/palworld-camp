import { PALS } from "./dataset.js";

// ===== Drops (recherche d'objet -> Pals qui le lâchent) =====
let DROP_INDEX = null;   // [[item, [{name, slug, amount, rate}]], ...] trié par objet

function rateNum(rate) { const m = /([\d.]+)/.exec(rate || ""); return m ? parseFloat(m[1]) : 0; }

function fmtAmount(amount) {
  const parts = (amount || "").split("-").map(s => s.trim());
  return parts.length === 2 && parts[0] === parts[1] ? parts[0] : amount;
}

function buildDropIndex() {
  const idx = new Map();
  PALS.forEach(p => (p.drops || []).forEach(d => {
    if (!idx.has(d.item)) idx.set(d.item, []);
    idx.get(d.item).push({ name: p.name, slug: p.slug, amount: d.amount, rate: d.rate });
  }));
  for (const arr of idx.values())
    arr.sort((a, b) => rateNum(b.rate) - rateNum(a.rate) || a.name.localeCompare(b.name, "fr"));
  DROP_INDEX = [...idx.entries()].sort((a, b) => a[0].localeCompare(b[0], "fr"));
}

function dropItemRow(item, pals) {
  const li = document.createElement("li");
  li.className = "drop-item";
  const palsHtml = pals.map(p => {
    const name = p.slug
      ? `<a href="https://palworld.gg/pal/${p.slug}" target="_blank" rel="noopener">${p.name}</a>`
      : p.name;
    return `<li class="drop-pal">${name}<span class="drop-amt">×${fmtAmount(p.amount)}</span>` +
      `<span class="drop-rate">${p.rate}</span></li>`;
  }).join("");
  li.innerHTML =
    `<div class="drop-item-name">${item} <span class="drop-pal-count">${pals.length} Pal${pals.length > 1 ? "s" : ""}</span></div>` +
    `<ul class="drop-pals">${palsHtml}</ul>`;
  return li;
}

export function renderDrops() {
  if (!DROP_INDEX) buildDropIndex();
  const q = document.getElementById("drop-search").value.trim().toLowerCase();
  const list = document.getElementById("drop-list");
  list.innerHTML = "";
  const items = DROP_INDEX.filter(([item]) => !q || item.toLowerCase().includes(q));
  document.getElementById("drop-count").textContent = items.length;
  if (!items.length) { list.innerHTML = `<li class="empty">Aucun objet trouvé.</li>`; return; }
  items.forEach(([item, pals]) => list.appendChild(dropItemRow(item, pals)));
}
