// server.js — Lumina Showroom 2025 (fondo blanco + partículas grises + FOB/PVP + breve en tarjetas, modal y carrito)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ================= Setup =================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

const PORT       = Number(process.env.PORT || 3000);
const EXCEL_URL  = (process.env.EXCEL_URL  || '').trim();
const EXCEL_PATH = (process.env.EXCEL_PATH || '').trim();
const SHEET_NAME = (process.env.SHEET_NAME || 'Master Season').trim();
const HEADER_ROW = Number(process.env.HEADER_ROW || 8);

const BUYERS = (process.env.BUYERS || 'OMNIA,HEB,SORIANA')
  .split(',').map(s => s.trim()).filter(Boolean);

const IMAGE_LOCAL_DIR = path.join(__dirname, 'public', 'images');
if (!fs.existsSync(IMAGE_LOCAL_DIR)) fs.mkdirSync(IMAGE_LOCAL_DIR, { recursive: true });
app.use('/images', express.static(IMAGE_LOCAL_DIR));

// Aliases de columnas
const A_MODEL = (process.env.COL_MODEL || 'Item #,Item,Modelo,#Item,Item#')
  .split(',').map(s => s.trim()).filter(Boolean);
const A_NAME  = (process.env.COL_NAME  || 'Description of Goods,Descripción de Goods,Descripcion de Goods')
  .split(',').map(s => s.trim()).filter(Boolean);
const A_SHORT = (process.env.COL_SHORT || 'Descripción genérica,Descripcion generica,Short')
  .split(',').map(s => s.trim()).filter(Boolean);
const A_IMAGE = (process.env.COL_IMAGE || 'image_url,picture,Imagen,Image')
  .split(',').map(s => s.trim()).filter(Boolean);
const A_PRICE = (process.env.COL_PRICE || 'Final unit cost,Unit price (USD),initial unit cost')
  .split(',').map(s => s.trim()).filter(Boolean);

const DATA_DIR = path.join(__dirname, 'data');
const CSV_PATH = path.join(DATA_DIR, 'interactions.csv');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const FALLBACK_IMG = 'https://drive.google.com/uc?id=1k6WmYPgtR1Sf8IthM_WlNi-XiM-Uhynr';

// ================= Utilidades =================
const norm = s => (s ?? '')
  .toString()
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

function fuzzyFindKey(obj, aliases) {
  const keys = Object.keys(obj || {});
  const nmap = new Map(keys.map(k => [norm(k), k]));
  for (const a of aliases) {
    const k = nmap.get(norm(a));
    if (k) return k;
  }
  for (const k of keys) {
    const nk = norm(k);
    if (aliases.some(a => nk.includes(norm(a)))) return k;
  }
  return null;
}

async function fetchExcelBuffer() {
  if (EXCEL_URL) {
    const res = await axios.get(EXCEL_URL, { responseType: 'arraybuffer' });
    return Buffer.from(res.data);
  }
  if (EXCEL_PATH) {
    const abs = path.isAbsolute(EXCEL_PATH) ? EXCEL_PATH : path.join(__dirname, EXCEL_PATH);
    return fs.readFileSync(abs);
  }
  throw new Error('No hay EXCEL_URL ni EXCEL_PATH configurado.');
}

function normalizeDriveUrl(u) {
  if (!u) return '';
  try {
    const s = String(u).trim();
    let m = s.match(/\/file\/d\/([^/]+)/);      if (m && m[1]) return `https://drive.google.com/uc?id=${m[1]}`;
    m = s.match(/[?&]id=([^&]+)/);              if (m && m[1]) return `https://drive.google.com/uc?id=${m[1]}`;
    m = s.match(/\/uc\?id=([^&]+)/);            if (m && m[1]) return `https://drive.google.com/uc?id=${m[1]}`;
    return s;
  } catch { return u; }
}

function tryLocalImage(model) {
  if (!model) return '';
  const base = model.replace(/[^\w\-]/g, '_');
  const exts = ['jpg', 'jpeg', 'png', 'webp'];
  for (const ext of exts) {
    const p = path.join(IMAGE_LOCAL_DIR, `${base}.${ext}`);
    if (fs.existsSync(p)) return `/images/${base}.${ext}`;
  }
  return '';
}

// Convierte "$1,234.50" o "1.234,50" -> 1234.50
function toNumber(v) {
  if (v == null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  const cleaned = s
    .replace(/[^\d,.\-]/g, '')
    .replace(/,(?=\d{3}\b)/g, '')
    .replace(/\.(?=\d{3}\b)/g, '');
  const normalized = cleaned.replace(/,(\d{1,2})$/, '.$1');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

app.get('/img', async (req, res) => {
  const u = (req.query.u || '').toString();
  if (!u) return res.status(400).send('missing u');
  const url = normalizeDriveUrl(u);
  try {
    const r = await axios.get(url, { responseType: 'stream', headers: { Accept: 'image/*' } });
    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
    r.data.pipe(res);
  } catch { res.status(502).send('image fetch error'); }
});

// ================= Carga de catálogo =================
let CATALOG = { items: [], headers: [] };

function loadCatalog() {
  const state = { items: [], headers: [] };
  const localXlsx = path.join(DATA_DIR, 'last.xlsx');
  if (!fs.existsSync(localXlsx)) return state;

  const buf = fs.readFileSync(localXlsx);
  const wb = xlsx.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    console.error(`❌ No encontré la hoja "${SHEET_NAME}".`);
    return state;
  }

  const headers = xlsx.utils.sheet_to_json(ws, {
    header: 1, range: HEADER_ROW - 1, raw: false, blankrows: false
  })[0] || [];

  const rows = xlsx.utils.sheet_to_json(ws, {
    header: headers, range: HEADER_ROW, raw: false, defval: '', blankrows: false
  });

  const modelKey = fuzzyFindKey(rows[0] || {}, A_MODEL);
  const nameKey  = fuzzyFindKey(rows[0] || {}, A_NAME);
  const shortKey = fuzzyFindKey(rows[0] || {}, A_SHORT);
  const imageKey = fuzzyFindKey(rows[0] || {}, A_IMAGE);
  const priceKey = fuzzyFindKey(rows[0] || {}, A_PRICE);

  state.items = rows.map(row => {
    const model = String(row[modelKey] || '').trim();
    if (!model) return null;

    const imgRaw   = String(row[imageKey] || '').trim();
    const imgDrive = normalizeDriveUrl(imgRaw);
    const imgLocal = tryLocalImage(model);
    const chosen   = imgDrive || imgLocal || FALLBACK_IMG;

    // Precio FOB (USD) y PVP/POP (MXN = FOB * 60)
    const priceUSD = priceKey ? toNumber(row[priceKey]) : NaN;
    const price    = Number.isFinite(priceUSD) ? +priceUSD.toFixed(2) : null;
    const pvp      = Number.isFinite(priceUSD) ? +(priceUSD * 60).toFixed(2) : null;

    return {
      model,
      name:  String(row[nameKey]  || '').trim(),
      short: String(row[shortKey] || '').trim(), // breve
      price, // FOB USD (número)
      pvp,   // PVP/POP MXN (número)
      image: chosen ? `/img?u=${encodeURIComponent(chosen)}` : '',
      raw: row,
    };
  }).filter(Boolean);

  state.headers = headers;
  return state;
}

async function refreshCatalog() {
  try {
    const buf = await fetchExcelBuffer();
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    fs.writeFileSync(path.join(DATA_DIR, 'last.xlsx'), buf);
    CATALOG = loadCatalog();
    console.log('Catalogo cargado: ' + CATALOG.items.length + ' productos.');
  } catch (e) {
    console.error('Error cargando catálogo:', e.message);
  }
}

// ========= API: datos & persistencia =========
app.get('/api/catalog_for_client', (req, res) => res.json(CATALOG));

app.get('/api/products', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) return res.json({ ok: true, items: [] });
  const items = CATALOG.items.filter(p =>
    p.model.toLowerCase().includes(q) ||
    (p.name || '').toLowerCase().includes(q) ||
    (p.short || '').toLowerCase().includes(q)
  );
  res.json({ ok: true, items });
});

app.post('/api/reload', async (_, res) => {
  await refreshCatalog();
  res.json({ ok: true, count: CATALOG.items.length });
});

app.post('/api/interactions', (req, res) => {
  const { buyer, model, action, note, device, price } = req.body || {};
  if (!buyer || !model || !action) return res.status(400).json({ ok: false, error: 'Campos obligatorios faltantes' });
  const now  = new Date().toISOString();
  const line = [now, buyer, model, action, (note || '').replace(/[\n\r,]/g, ' '), device || '', price ?? ''].join(',') + '\n';
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, 'time,buyer,model,action,note,device,price\n', 'utf8');
  fs.appendFileSync(CSV_PATH, line, 'utf8');
  res.json({ ok: true });
});

// ================= UI (Glass UI + Fondo Blanco + Partículas Grises) =================
app.get('/', (_, res) => {
  const buyersJS = JSON.stringify(BUYERS);
  res.type('html').send(`<!doctype html><html lang="es"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Lumina Showroom 2025</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --brand: #0D9488;
    --brand-light: #CCFBF1;
    --danger: #E11D48;
    --text-primary: #1E293B;   /* texto oscuro */
    --text-secondary: #475569; /* gris medio */
    --border-color: rgba(0, 0, 0, 0.1);
    --bg-card: rgba(255, 255, 255, 0.8);
    --bg-modal: #ffffff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Inter', sans-serif; background-color: #ffffff; color: var(--text-primary); font-size: 14px; }
  #particles-js { position: fixed; width: 100%; height: 100%; top: 0; left: 0; z-index: -1; }
  .wrap { max-width: 1280px; margin: 0 auto; padding: 24px; }
  .header-card { background: var(--bg-card); backdrop-filter: blur(10px); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .header-controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 24px; }
  select, input, button {
    border-radius: 8px; border: 1px solid var(--border-color); background-color: rgba(255, 255, 255, 0.8);
    height: 40px; padding: 0 12px; font-size: 14px; outline: none; transition: all 0.2s; color: var(--text-primary);
  }
  select:focus, input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-light); }
  button { cursor: pointer; font-weight: 600; }
  .btn-primary { background-color: var(--brand); border-color: var(--brand); color: white; }
  .btn-ghost { background-color: transparent; }
  .tile { background: var(--bg-card); backdrop-filter: blur(10px); border: 1px solid var(--border-color); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .tile-img { width: 100%; height: 220px; border-radius: 8px; background-color: #f1f5f9; overflow: hidden; }
  .tile-img img { width: 100%; height: 100%; object-fit: contain; }
  .tile-model { font-size: 18px; font-weight: 700; }
  .tile-desc { font-size: 14px; color: var(--text-secondary); line-height: 1.5; min-height: 48px; }
  .tile-actions { display: flex; gap: 10px; margin-top: auto; }
  textarea { width: 100%; min-height: 60px; border-radius: 8px; border: 1px solid var(--border-color); padding: 8px 12px; font-family: inherit; background-color: #f8fafc; color: var(--text-primary); }
  .cart-icon-wrapper { position: fixed; top: 24px; right: 24px; z-index: 1000; }
  .cart-icon { width: 50px; height: 50px; border-radius: 50%; background: var(--bg-card); backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: center; cursor: pointer; border: 1px solid var(--border-color); }
  .cart-count { position: absolute; top: -5px; right: -5px; background: var(--danger); font-weight: 700; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; border: 2px solid var(--bg-modal); color: white; }
  .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.3); backdrop-filter: blur(5px); z-index: 1001; display: none; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal-content { width: 90%; max-width: 800px; background: var(--bg-modal); border: 1px solid var(--border-color); border-radius: 12px; max-height: 85vh; display: flex; flex-direction: column; }
  .modal-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; }
  .modal-body { padding: 24px; overflow-y: auto; }
  .modal-footer { padding: 16px 24px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 12px; }
  .cart-item { display: grid; grid-template-columns: 70px 1fr auto; gap: 16px; align-items: center; background: #f1f5f9; padding: 16px; border-radius: 8px; border: 1px solid var(--border-color); margin-bottom: 16px; }
  .cart-item-img img { width: 100%; height: 100%; object-fit: contain; }
  .detail-pre { white-space: pre-wrap; word-wrap: break-word; font-family: monospace; background-color: #f8fafc; padding: 16px; border-radius: 8px; }
</style>
</head><body>
<div id="particles-js"></div>
<div class="cart-icon-wrapper" id="openCart">
  <div class="cart-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 22C9.55228 22 10 21.5523 10 21C10 20.4477 9.55228 20 9 20C8.44772 20 8 20.4477 8 21C8 21.5523 8.44772 22 9 22Z" stroke="#334155" stroke-width="2"/><path d="M20 22C20.5523 22 21 21.5523 21 21C21 20.4477 20.5523 20 20 20C19.4477 20 19 20.4477 19 21C19 21.5523 19.4477 22 20 22Z" stroke="#334155" stroke-width="2"/><path d="M1 1H5L7.68 14.39C7.87201 15.3262 8.63334 16.009 9.58 16H19.4C20.3467 16.009 21.108 15.3262 21.3 14.39L23 6H6" stroke="#334155" stroke-width="2" stroke-linecap="round"/></svg></div>
  <div class="cart-count" id="cartCount" style="display:none">0</div>
</div>
<div class="wrap">
  <div class="header-card">
    <h1 style="margin: 0 0 16px 0;">Lumina Showroom 2025</h1>
    <div class="header-controls">
      <select id="buyer"></select>
      <input id="q" placeholder="Buscar por modelo o nombre..." style="flex-grow: 1;"/>
      <button class="btn-primary" id="btnbuscar">Buscar</button>
      <button class="btn-ghost" id="reload">Recargar</button>
    </div>
  </div>
  <div id="results" class="grid"></div>
</div>
<div class="modal-overlay" id="cartModal">
  <div class="modal-content">
    <div class="modal-header"><h2>Mi Selección</h2><button class="btn-ghost" id="closeCart">Cerrar</button></div>
    <div class="modal-body" id="cartBody"></div>
    <div class="modal-footer"><button class="btn-ghost" id="clearCart">Vaciar</button><button class="btn-primary" id="submitCart">Enviar Selección</button></div>
  </div>
</div>
<div class="modal-overlay" id="detailModal">
  <div class="modal-content">
    <div class="modal-header"><h2 id="detailTitle"></h2><button class="btn-ghost" id="closeDetail">Cerrar</button></div>
    <div class="modal-body"><pre id="detailContent" class="detail-pre"></pre></div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/particles.js@2.0.0/particles.min.js"></script>
<script>
  particlesJS("particles-js", {
    "particles": {
      "number": { "value": 80, "density": { "enable": true, "value_area": 800 } },
      "color": { "value": "#94a3b8" }, /* gris claro para que se noten sobre blanco */
      "shape": { "type": "circle" },
      "opacity": { "value": 0.5, "random": true },
      "size": { "value": 3, "random": true },
      "line_linked": { "enable": true, "distance": 150, "color": "#cbd5e1", "opacity": 0.4, "width": 1 },
      "move": { "enable": true, "speed": 1, "direction": "none", "out_mode": "out" }
    },
    "interactivity": {
      "detect_on": "canvas",
      "events": { "onhover": { "enable": true, "mode": "grab" }, "onclick": { "enable": true, "mode": "push" } }
    }
  });
</script>
<script>
const BUYERS = ${buyersJS};
let currentBuyer = BUYERS[0] || 'OMNIA';
let cart = [];
let CATALOG = { items: [] }; // copia cliente para detalles

function init() {
  renderBuyer();
  setupEventListeners();
  updateCartCount();
  // Cargar catálogo para "Ver más"
  fetch('/api/catalog_for_client')
    .then(r => r.json())
    .then(data => { CATALOG = data || { items: [] }; });
}

function renderBuyer(){
  const sel = document.getElementById('buyer');
  sel.innerHTML = BUYERS.map(b => \`<option \${b === currentBuyer ? 'selected' : ''}>\${b}</option>\`).join('');
  sel.onchange = () => currentBuyer = sel.value;
}

async function buscar(){
  const q = document.getElementById('q').value.trim();
  const resultsGrid = document.getElementById('results');
  resultsGrid.innerHTML = '<p>Buscando...</p>';
  const response = await fetch('/api/products?q=' + encodeURIComponent(q));
  const data = await response.json();
  resultsGrid.innerHTML = '';
  if (!data.items || data.items.length === 0) {
    resultsGrid.innerHTML = '<p>No se encontraron productos.</p>';
    return;
  }
  data.items.forEach(p => {
    const card = document.createElement('div');
    card.className = 'tile';
    card.innerHTML = \`
      <div class="tile-img">\${p.image ? \`<img src="\${p.image}" alt="\${p.model}"/>\` : ''}</div>
      <div>
        <div class="tile-model">\${p.model}</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin:6px 0 8px 0;">
          \${p.price != null ? \`<span style="border:1px solid var(--border-color);padding:4px 8px;border-radius:6px;">FOB: $\${p.price.toFixed(2)} USD</span>\` : ''}
          \${p.pvp   != null ? \`<span style="border:1px solid var(--border-color);padding:4px 8px;border-radius:6px;">PVP: $\${p.pvp.toFixed(2)} MXN</span>\` : ''}
        </div>
        <div class="tile-desc">\${p.short || p.name || 'Sin descripción'}</div>
      </div>
      <textarea class="note" placeholder="Añadir comentario..."></textarea>
      <div class="tile-actions">
        <button class="btn-primary add" data-model="\${p.model}">Añadir</button>
        <button class="btn-ghost info" data-model="\${p.model}">Ver más</button>
      </div>
    \`;
    resultsGrid.appendChild(card);
  });
}

function addToCart(item) {
  const existingItem = cart.find(x => x.model === item.model);
  if (existingItem) {
    existingItem.note  = item.note;
    existingItem.price = item.price;
    existingItem.pvp   = item.pvp;
    existingItem.short = item.short;
    existingItem.image = item.image;
  } else {
    cart.push(item);
  }
  updateCartCount();
  openCart();
}

function removeFromCart(model) {
  cart = cart.filter(x => x.model !== model);
  updateCartCount();
  renderCartItems();
}

function updateCartCount() {
  const countEl = document.getElementById('cartCount');
  countEl.textContent = cart.length;
  countEl.style.display = cart.length > 0 ? 'flex' : 'none';
}

function openCart() { renderCartItems(); document.getElementById('cartModal').classList.add('open'); }
function closeCart() { document.getElementById('cartModal').classList.remove('open'); }

function renderCartItems() {
  const body = document.getElementById('cartBody');
  body.innerHTML = cart.length === 0
    ? '<p>Tu selección está vacía.</p>'
    : cart.map(it => \`
      <div class="cart-item">
        <div class="cart-item-img">\${it.image ? \`<img src="\${it.image}" alt="\${it.model}"/>\` : ''}</div>
        <div>
          <div style="font-weight: 700; margin-bottom: 4px;">\${it.model}</div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;">\${it.short || ''}</div>
          <div style="font-size: 12px; margin-bottom: 8px;">
            \${it.price != null ? \`<strong>FOB:</strong> $\${Number(it.price).toFixed(2)} USD\` : ''}
            \${(it.price!=null && it.pvp!=null) ? ' · ' : ''}
            \${it.pvp   != null ? \`<strong>PVP:</strong> $\${Number(it.pvp).toFixed(2)} MXN\` : ''}
          </div>
          <textarea class="note edit-note" data-model="\${it.model}" placeholder="Comentario...">\${it.note || ''}</textarea>
        </div>
        <button class="btn-ghost del" data-model="\${it.model}">Quitar</button>
      </div>
    \`).join('');
}

async function submitCart() {
  if (cart.length === 0) return alert('No hay artículos.');
  for (const item of cart) {
    await postInteraction('selected', item);
    if (item.note) await postInteraction('note', item);
  }
  alert(\`Selección enviada para "\${currentBuyer}".\`);
  cart = [];
  updateCartCount();
  closeCart();
}

async function postInteraction(action, item) {
  return fetch('/api/interactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      buyer: currentBuyer,
      model: item.model,
      action,
      note: action === 'note' ? item.note : '',
      device: navigator.userAgent,
      price: item.price ?? '' // guardamos FOB
    })
  });
}

function showDetails(model) {
  const product = (CATALOG.items || []).find(p => p.model === model);
  if (!product) return;

  document.getElementById('detailTitle').textContent = \`\${product.model}\`;

  const breve = product.short || product.name || 'Sin descripción.';
  const pricesLine = \`
    \${product.price!=null ? \`FOB: $\${product.price.toFixed(2)} USD\` : ''}
    \${product.pvp!=null   ? \` | PVP: $\${product.pvp.toFixed(2)} MXN\` : ''}
  \`.trim();

  const detailsText =
    \`\${breve}\n\n\${pricesLine}\n\n\` +
    Object.entries(product.raw || {}).map(([k,v]) => \`\${k}: \${v ?? ''}\`).join('\\n');

  document.getElementById('detailContent').textContent = detailsText;
  document.getElementById('detailModal').classList.add('open');
}

function setupEventListeners() {
  document.getElementById('btnbuscar').onclick = buscar;
  document.getElementById('q').addEventListener('keydown', e => e.key === 'Enter' && buscar());
  document.getElementById('reload').onclick = async () => {
    const btn = document.getElementById('reload');
    const old = btn.textContent;
    btn.textContent = '...';
    await fetch('/api/reload', { method: 'POST' });
    btn.textContent = old;
  };
  document.getElementById('openCart').onclick  = openCart;
  document.getElementById('closeCart').onclick = closeCart;
  document.getElementById('submitCart').onclick = submitCart;
  document.getElementById('clearCart').onclick = () => {
    if (confirm('¿Vaciar selección?')) { cart = []; updateCartCount(); renderCartItems(); }
  };

  // Delegación
  document.getElementById('results').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const model = btn.dataset.model;
    if (!model) return;
    const product = (CATALOG.items || []).find(p => p.model === model);

    if (btn.classList.contains('add')) {
      const tile = btn.closest('.tile');
      const note = tile.querySelector('.note')?.value.trim() || '';
      addToCart({
        model,
        note,
        short: product?.short || '',
        price: product?.price ?? '', // FOB USD
        pvp:   product?.pvp ?? null, // PVP MXN
        image: product?.image || ''
      });
    }
    if (btn.classList.contains('info')) {
      showDetails(model);
    }
  });

  document.getElementById('cartBody').addEventListener('click', e => {
    const btn = e.target.closest('button.del');
    if (btn) removeFromCart(btn.dataset.model);
  });

  document.getElementById('cartBody').addEventListener('input', e => {
    if (e.target.classList.contains('edit-note')) {
      const item = cart.find(i => i.model === e.target.dataset.model);
      if (item) item.note = e.target.value;
    }
  });

  document.getElementById('closeDetail').onclick =
    () => document.getElementById('detailModal').classList.remove('open');
}

document.addEventListener('DOMContentLoaded', init);
</script>
</body></html>`);
});

// ================= Arranque del Servidor =================
app.listen(PORT, async () => {
  await refreshCatalog();
  console.log('Servidor escuchando en http://localhost:' + PORT);
});
