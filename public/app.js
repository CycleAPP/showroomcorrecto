// Partículas de fondo
particlesJS("particles-js", {
  "particles":{"number":{"value":80,"density":{"enable":true,"value_area":800}},"color":{"value":"#94a3b8"},"shape":{"type":"circle"},"opacity":{"value":0.5,"random":true},"size":{"value":3,"random":true},"line_linked":{"enable":true,"distance":150,"color":"#cbd5e1","opacity":0.4,"width":1},"move":{"enable":true,"speed":1,"direction":"none","out_mode":"out"}},
  "interactivity":{"detect_on":"canvas","events":{"onhover":{"enable":true,"mode":"grab"},"onclick":{"enable":true,"mode":"push"}}}
});

// ---- Config global expuesta por /config.js ----
const BUYERS = (window.__APP_CONFIG__?.BUYERS || []);
let currentBuyer = BUYERS[0] || 'OMNIA';

// ---- Estado UI ----
let cart = [];
let cartVersion = 0; // versión del servidor para sincronización
let CATALOG = { items: [] };

// ---- BroadcastChannel para sincronizar entre pestañas (mismo dispositivo) ----
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('lumina_cart') : null;
if (bc) {
  bc.onmessage = (ev) => {
    const { type, data } = ev.data || {};
    if (type === 'cart_sync' && data?.buyer === currentBuyer) {
      cart = data.items || [];
      cartVersion = data.version || 0;
      updateCartCount();
      renderCartItems();
    }
  };
}

// ---- Helpers de DOM ----
function $(id){ return document.getElementById(id); }
function qs(sel){ return document.querySelector(sel); }

// ---- Render inicial ----
function renderBuyer(){
  const sel = $('buyer');
  sel.innerHTML = BUYERS.map(b => `<option ${b === currentBuyer ? 'selected' : ''}>${b}</option>`).join('');
  sel.onchange = async () => {
    currentBuyer = sel.value;
    await syncCartFromServer(); // cambia de comprador => carga su carrito
  };
}

function updateCartCount(){
  const countEl = $('cartCount');
  countEl.textContent = cart.length;
  countEl.style.display = cart.length > 0 ? 'flex' : 'none';
}

function renderCartItems(){
  const body = $('cartBody');
  body.innerHTML = cart.length === 0
    ? '<p>Tu selección está vacía.</p>'
    : cart.map(it => `
      <div class="cart-item">
        <div class="cart-item-img">${it.image ? `<img src="${it.image}" alt="${it.model}"/>` : ''}</div>
        <div>
          <div style="font-weight:700;margin-bottom:4px;">${it.model}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">${it.short || ''}</div>
          <div style="font-size:12px;margin-bottom:8px;">
            ${it.price != null ? `<strong>FOB:</strong> $${Number(it.price).toFixed(2)} USD` : ''}
            ${(it.price!=null && it.pvp!=null) ? ' · ' : ''}
            ${it.pvp   != null ? `<strong>PVP:</strong> $${Number(it.pvp).toFixed(2)} MXN` : ''}
          </div>
          <textarea class="note edit-note" data-model="${it.model}" placeholder="Comentario...">${it.note || ''}</textarea>
        </div>
        <button class="btn-ghost del" data-model="${it.model}">Quitar</button>
      </div>
    `).join('');
}

// ---- Catálogo / búsqueda ----
async function buscar(){
  const q = $('q').value.trim();
  const resultsGrid = $('results');
  resultsGrid.innerHTML = '<p>Buscando...</p>';
  const data = await (await fetch('/api/products?q=' + encodeURIComponent(q))).json();
  resultsGrid.innerHTML = '';
  if (!data.items || data.items.length === 0) {
    resultsGrid.innerHTML = '<p>No se encontraron productos.</p>';
    return;
  }
  data.items.forEach(p => {
    const card = document.createElement('div');
    card.className = 'tile';
    card.innerHTML = `
      <div class="tile-img">${p.image ? `<img src="${p.image}" alt="${p.model}"/>` : ''}</div>
      <div>
        <div class="tile-model">${p.model}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 8px 0;">
          ${p.price != null ? `<span style="border:1px solid var(--border-color);padding:4px 8px;border-radius:6px;">FOB: $${p.price.toFixed(2)} USD</span>` : ''}
          ${p.pvp   != null ? `<span style="border:1px solid var(--border-color);padding:4px 8px;border-radius:6px;">PVP: $${p.pvp.toFixed(2)} MXN</span>` : ''}
        </div>
        <div class="tile-desc">${p.short || p.name || 'Sin descripción'}</div>
      </div>
      <textarea class="note" placeholder="Añadir comentario..."></textarea>
      <div class="tile-actions">
        <button class="btn-primary add" data-model="${p.model}">Añadir</button>
        <button class="btn-ghost info" data-model="${p.model}">Ver más</button>
      </div>`;
    resultsGrid.appendChild(card);
  });
}

// ---- Detalles ----
function showDetails(model) {
  const product = (CATALOG.items || []).find(p => p.model === model);
  if (!product) return;
  $('detailTitle').textContent = `${product.model}`;
  const breve = product.short || product.name || 'Sin descripción.';
  const pricesLine = `
    ${product.price!=null ? `FOB: $${product.price.toFixed(2)} USD` : ''}
    ${product.pvp!=null ? ` | PVP: $${product.pvp.toFixed(2)} MXN` : ''}
  `.trim();
  const detailsText =
    `${breve}\n\n${pricesLine}\n\n` +
    Object.entries(product.raw || {}).map(([k,v]) => `${k}: ${v ?? ''}`).join('\n');
  $('detailContent').textContent = detailsText;
  $('detailModal').classList.add('open');
}

// ---- Carrito: servidor (compartido) ----
async function syncCartFromServer(){
  const r = await fetch('/api/cart?buyer=' + encodeURIComponent(currentBuyer));
  const data = await r.json();
  if (data?.ok) {
    cart = data.cart || [];
    cartVersion = data.version || 0;
    updateCartCount();
    renderCartItems();
    if (bc) bc.postMessage({ type:'cart_sync', data:{ buyer: currentBuyer, items: cart, version: cartVersion }});
  }
}

async function serverAddToCart(item){
  const r = await fetch('/api/cart/add', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ buyer: currentBuyer, item })
  });
  const data = await r.json();
  if (data?.ok) {
    cart = data.cart || [];
    cartVersion = data.version || 0;
    updateCartCount(); renderCartItems();
    if (bc) bc.postMessage({ type:'cart_sync', data:{ buyer: currentBuyer, items: cart, version: cartVersion }});
  }
}

async function serverRemove(model){
  const r = await fetch('/api/cart/remove', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ buyer: currentBuyer, model })
  });
  const data = await r.json();
  if (data?.ok) {
    cart = data.cart || [];
    cartVersion = data.version || 0;
    updateCartCount(); renderCartItems();
    if (bc) bc.postMessage({ type:'cart_sync', data:{ buyer: currentBuyer, items: cart, version: cartVersion }});
  }
}

async function serverClear(){
  const r = await fetch('/api/cart/clear', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ buyer: currentBuyer })
  });
  const data = await r.json();
  if (data?.ok) {
    cart = data.cart || [];
    cartVersion = data.version || 0;
    updateCartCount(); renderCartItems();
    if (bc) bc.postMessage({ type:'cart_sync', data:{ buyer: currentBuyer, items: cart, version: cartVersion }});
  }
}

// ---- Carrito: UI wrappers (llaman server*) ----
async function addToCartFromProduct(product, note){
  const item = {
    model: product?.model,
    note: note || '',
    short: product?.short || '',
    price: product?.price ?? '',
    pvp:   product?.pvp ?? null,
    image: product?.image || ''
  };
  await serverAddToCart(item);
}

async function removeFromCart(model){ await serverRemove(model); }

// ---- Envío de selección (csv log + no vacía servidor si no quieres) ----
async function submitCart(){
  if (cart.length === 0) return alert('No hay artículos.');
  for (const item of cart) {
    await postInteraction('selected', item);
    if (item.note) await postInteraction('note', item);
  }
  alert(`Selección enviada para "${currentBuyer}".`);
  await serverClear();
}

async function postInteraction(action, item){
  return fetch('/api/interactions', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      buyer: currentBuyer,
      model: item.model,
      action,
      note: action==='note' ? item.note : '',
      device: navigator.userAgent,
      price: item.price ?? ''
    })
  });
}

// ---- Polling para ver cambios de otros dispositivos ----
let pollTimer = null;
function startPolling(){
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch('/api/cart?buyer=' + encodeURIComponent(currentBuyer));
      const data = await r.json();
      if (data?.ok && data.version !== cartVersion) {
        cart = data.cart || [];
        cartVersion = data.version || 0;
        updateCartCount();
        renderCartItems();
        if (bc) bc.postMessage({ type:'cart_sync', data:{ buyer: currentBuyer, items: cart, version: cartVersion }});
      }
    } catch {}
  }, 5000); // 5s
}
function stopPolling(){
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ---- Eventos ----
function setupEventListeners(){
  $('btnbuscar').onclick = buscar;
  $('q').addEventListener('keydown', e => e.key === 'Enter' && buscar());

  $('reload').onclick = async () => {
    const btn = $('reload');
    const old = btn.textContent; btn.textContent = '...';
    await fetch('/api/reload', { method: 'POST' }); btn.textContent = old;

    // Recargar catálogo y refrescar UI
    const data = await (await fetch('/api/catalog_for_client')).json();
    CATALOG = data || { items: [] };
    await buscar();
  };

  $('openCart').onclick  = () => { renderCartItems(); $('cartModal').classList.add('open'); };
  $('closeCart').onclick = () => $('cartModal').classList.remove('open');
  $('submitCart').onclick = submitCart;
  $('clearCart').onclick = async () => { if (confirm('¿Vaciar selección?')) await serverClear(); };

  $('results').addEventListener('click', async e => {
    const btn = e.target.closest('button'); if (!btn) return;
    const model = btn.dataset.model; if (!model) return;
    const product = (CATALOG.items || []).find(p => p.model === model);

    if (btn.classList.contains('add')) {
      const tile = btn.closest('.tile');
      const note = tile.querySelector('.note')?.value.trim() || '';
      await addToCartFromProduct(product, note);
      $('cartModal').classList.add('open');
    }
    if (btn.classList.contains('info')) showDetails(model);
  });

  $('cartBody').addEventListener('click', async e => {
    const btn = e.target.closest('button.del');
    if (btn) await removeFromCart(btn.dataset.model);
  });

  $('cartBody').addEventListener('input', async e => {
    if (e.target.classList.contains('edit-note')) {
      const model = e.target.dataset.model;
      // actualiza nota en servidor (reutilizando add que hace upsert)
      const existing = cart.find(i => i.model === model) || { model };
      await serverAddToCart({ ...existing, note: e.target.value });
    }
  });

  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startPolling();
    else stopPolling();
  });
}

// ---- Init ----
async function init(){
  renderBuyer();
  setupEventListeners();
  updateCartCount();

  const data = await (await fetch('/api/catalog_for_client')).json();
  CATALOG = data || { items: [] };
  await buscar();

  await syncCartFromServer(); // carga carrito del comprador actual
  startPolling();
}
document.addEventListener('DOMContentLoaded', init);
