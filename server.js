// server.js — Lumina Showroom 2025 (COMPLETO Y CORREGIDO)
// - Imágenes de catálogo: SOLO Cloudinary (si no hay, intenta URL del Excel vía /img; no usa locales)
// - Botón "Recargar": ejecuta Python (subida incremental) y luego refresca catálogo
// - Productos personalizados: guarda foto local y salen en carrito + PDF/Excel
// - Precios por comprador
// - HTML embebido sin backticks internos (evita errores de sintaxis)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import xlsx from 'xlsx';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import { spawn } from 'child_process';

// sharp opcional para convertir imágenes personalizadas a PNG
let Sharp = null;
try {
  const mod = await import('sharp');
  Sharp = mod.default || mod;
} catch (_) {}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ===== env base =====
const PORT             = Number(process.env.PORT || 3000);
const EXCEL_URL        = (process.env.EXCEL_URL  || '').trim();
const EXCEL_PATH       = (process.env.EXCEL_PATH || '').trim();
const SHEET_NAME_ENV   = (process.env.SHEET_NAME || '').trim();   // '' => autodetect
const HEADER_ROW_ENV   = Number(process.env.HEADER_ROW || 0);     // 0 => autodetect

const BUYERS = (process.env.BUYERS || 'OMNIA,HEB,SORIANA,CHEDRAUI,LA COMER,LIVERPOOL,SEARS,3B,CLUBES,DSW,CALIMAX')
  .split(',').map(s => s.trim()).filter(Boolean);

// Cloudinary (obligatorio para catálogo)
const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_FOLDER     = (process.env.CLOUDINARY_FOLDER || 'showroom_2025').trim();

// Paths
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const IMAGE_LOCAL_DIR = path.join(__dirname, 'public', 'images'); // para personalizados
if (!fs.existsSync(IMAGE_LOCAL_DIR)) fs.mkdirSync(IMAGE_LOCAL_DIR, { recursive: true });
app.use('/images', express.static(IMAGE_LOCAL_DIR));

const CSV_PATH      = path.join(DATA_DIR, 'interactions.csv');
const CART_PATH     = path.join(DATA_DIR, 'cart.json');
const CATALOG_XLSX  = path.join(DATA_DIR, 'last.xlsx');
const FALLBACK_IMG  = 'https://dummyimage.com/800x800/e2e8f0/94a3b8&text=Sin+imagen';

// ===== Aliases de columnas =====
const AL = (key, def) => (process.env[key] || def).split(',').map(s=>s.trim()).filter(Boolean);

const A_MODEL            = AL('COL_MODEL',               '2026 Model,2026 model,Model,Item #,Item,Modelo,#Item,Item#');
const A_IMAGE            = AL('COL_IMAGE',               'Picture,Extra Pictures,image_url,picture,Imagen,Image');
const A_SHORT            = AL('COL_SHORT',               'Short description,Descripción genérica,Descripcion generica,Short');
const A_NAME_LONG        = AL('COL_NAME',                'Item Description,Description of Goods,Descripción de Goods,Descripcion de Goods');
const A_PACKAGING_TYPE   = AL('COL_PACKAGING_TYPE',      'Packaging type,Packaging');
const A_MASTER_PACK      = AL('COL_MASTER_PACK',         'Master Pack,Master pack');
const A_CBM_PER_PIECE    = AL('COL_CBM_PER_PIECE',       'CBMs x piece,CBM x piece,CBM/piece');
const A_BULB_TECH        = AL('COL_BULB_TECH',           'Bulb Tech');
const A_NUM_BULBS        = AL('COL_NUM_BULBS',           '# of Bulbs,Number of Bulbs');
const A_COLOR_BULB       = AL('COL_COLOR_BULB',          'Color Bulb');
const A_WIRE_COLOR       = AL('COL_WIRE_COLOR',          'Wire Color');
const A_TOTAL_LENGTH_M   = AL('COL_TOTAL_LENGTH_M',      'Total Length (m),Total Lenght (m)');
const A_POWER_SUPPLY     = AL('COL_POWER_SUPPLY',        'Power supply');
const A_LIGHTED_LENGTH_M = AL('COL_LIGHTED_LENGTH_M',    'Lighted Length (m),Lighted Lenght (m)');
const A_LEAD_IN_M        = AL('COL_LEAD_IN_M',           'Lead in (m)');
const A_LEAD_OUT_M       = AL('COL_LEAD_OUT_M',          'Lead out (m)');
const A_END_CONNECTOR    = AL('COL_END_CONNECTOR',       'End connector');
const A_FUNCTIONS        = AL('COL_FUNCTIONS',           'Function (#),# of Functions,Functions');
const A_INCLUDED_ACC     = AL('COL_INCLUDED_ACCESSORIES','Included accessories,Included accesories,Accessories');

// ========= Carrito persistente =========
let CARTS = {};
try { if (fs.existsSync(CART_PATH)) CARTS = JSON.parse(fs.readFileSync(CART_PATH,'utf8')); } catch {}
const saveCarts = ()=>{ try{ fs.writeFileSync(CART_PATH, JSON.stringify(CARTS,null,2),'utf8'); }catch{} };
const cartOf = buyer => { if (!buyer) return []; CARTS[buyer] ||= []; return CARTS[buyer]; };

// ========= Utils =========
const norm = s => (s ?? '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/\s+/g,' ').trim().toLowerCase();
function fuzzyFindKey(obj, aliases){
  const keys = Object.keys(obj||{}), nmap=new Map(keys.map(k=>[norm(k),k]));
  for (const a of aliases){ const k=nmap.get(norm(a)); if (k) return k; }
  for (const k of keys){ const nk=norm(k); if (aliases.some(a=>nk.includes(norm(a)))) return k; }
  return null;
}
const pick = (row, aliases) => {
  const k = fuzzyFindKey(row, aliases);
  return k ? row[k] : '';
};
async function fetchExcelBuffer(){
  if (EXCEL_URL){ const r = await axios.get(EXCEL_URL,{responseType:'arraybuffer'}); return Buffer.from(r.data); }
  if (EXCEL_PATH){ const abs = path.isAbsolute(EXCEL_PATH)?EXCEL_PATH:path.join(__dirname,EXCEL_PATH); return fs.readFileSync(abs); }
  throw new Error('No hay EXCEL_URL ni EXCEL_PATH configurado.');
}
function normalizeDriveUrl(u){
  if (!u) return '';
  const s=String(u).trim();
  let m=s.match(/\/file\/d\/([^/]+)/); if (m?.[1]) return `https://drive.google.com/uc?id=${m[1]}`;
  m=s.match(/[?&]id=([^&]+)/);         if (m?.[1]) return `https://drive.google.com/uc?id=${m[1]}`;
  m=s.match(/\/uc\?id=([^&]+)/);       if (m?.[1]) return `https://drive.google.com/uc?id=${m[1]}`;
  return s;
}
const modelBase = m => String(m||'').trim().replace(/[^\w\-]+/g,'_');
const cloudinaryUrlForModel = m => CLOUDINARY_CLOUD_NAME
  ? `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/f_auto,q_auto/${CLOUDINARY_FOLDER}/${modelBase(m)}`
  : '';

function toNumber(v){
  const s=String(v??'').trim(); if (!s) return NaN;
  const cleaned=s.replace(/[^\d,.\-]/g,'').replace(/,(?=\d{3}\b)/g,'').replace(/\.(?=\d{3}\b)/g,'');
  const normalized=cleaned.replace(/,(\d{1,2})$/,'.$1');
  const n=Number(normalized);
  return Number.isFinite(n)?n:NaN;
}

// Imagen final para catálogo: SOLO Cloudinary; si no existe, intenta URL del Excel (proxy) y si no, fallback
function catalogImageFor(model, xlsUrl) {
  const cld = cloudinaryUrlForModel(model);
  if (cld) return cld; // preferido
  const fromXls = normalizeDriveUrl(xlsUrl || '');
  return fromXls ? `/img?u=${encodeURIComponent(fromXls)}` : FALLBACK_IMG;
}

// ========= Proxy de imagen (Drive, etc.) =========
app.get('/img', async (req,res)=>{
  const u=String(req.query.u||''); if (!u) return res.status(400).send('missing u');
  const url=normalizeDriveUrl(u);
  try{
    const r=await axios.get(url,{responseType:'stream',headers:{Accept:'image/*'}});
    res.setHeader('Content-Type', r.headers['content-type']||'image/jpeg');
    r.data.pipe(res);
  }catch{ res.status(502).send('image fetch error'); }
});

// ========= Catálogo + precios por comprador =========
let CATALOG = { items: [], headers: [], headerRow: 0, sheetName: '' };

// Mapeo exacto de columnas por comprador (FOB/PVP)
const BUYER_PRICE_MAP = {
  'SORIANA': { FOB: ['Precio FOB Soriana ($USD)'], PVP: ['PVP Soriana Estimado ($MXN)'] },
  'CHEDRAUI': { FOB: ['Precio FOB Chedraui ($USD)'], PVP: ['PVP Chedraui Estimado ($MXN)'] },
  'HEB':      { FOB: ['Precio FOB HEB ($USD)'],      PVP: ['PVP HEB Estimado ($MXN)'] },
  'LA COMER': { FOB: ['Precio FOB La comer ($USD)','Precio FOB La Comer ($USD)'],
                PVP: ['PVP La comer Estimado ($MXN)','PVP La Comer Estimado ($MXN)'] },
  'LIVERPOOL':{ FOB: ['Precio FOB Liverpool ($USD)'], PVP: ['PVP Liverpool Estimado ($MXN)'] },
  'SEARS':    { FOB: ['Precio FOB Sears ($USD)'],     PVP: ['PVP Sears Estimado ($MXN)'] },
  '3B':       { FOB: ['Precio FOB 3B ($USD)'],        PVP: ['PVP 3B Estimado ($MXN)'] },
  'CLUBES':   { FOB: ['Precio FOB Clubes ($USD)'],    PVP: ['PVP Clubes Estimado ($MXN)'] },
  'DSW':      { FOB: ['Precio FOB DSW ($USD)'],       PVP: ['PVP DSW Estimado ($MXN)'] },
  'CALIMAX':  { FOB: ['Precio FOB Calimax ($USD)'],   PVP: ['PVP Calimax Estimado ($MXN)'] },
};

function autodetectHeaderRow(ws){
  if (HEADER_ROW_ENV>0) return HEADER_ROW_ENV;
  const matrix = xlsx.utils.sheet_to_json(ws,{header:1,raw:false,blankrows:false,defval:''});
  const KEY_HINTS = ['item','model','#','picture','image','description','short','precio','pvp','packaging','master','cbm','bulb','length','power','lead','connector','function','accesor'];
  let bestRow=1, bestScore=-1;
  for (let r=0; r<Math.min(30, matrix.length); r++){
    const row = (matrix[r]||[]).map(v=>String(v||'').trim());
    if (!row.length) continue;
    const nonEmpty = row.filter(Boolean).length;
    const score = nonEmpty + row.reduce((acc,cell)=>acc + (KEY_HINTS.some(k=>cell.toLowerCase().includes(k))?2:0),0);
    if (score>bestScore){ bestScore=score; bestRow=r+1; }
  }
  return bestRow;
}

function loadCatalog(){
  const state={ items:[], headers:[], headerRow:0, sheetName:'' };
  if (!fs.existsSync(CATALOG_XLSX)) return state;

  const wb=xlsx.read(fs.readFileSync(CATALOG_XLSX),{type:'buffer'});
  let sheetName = SHEET_NAME_ENV && wb.SheetNames.includes(SHEET_NAME_ENV) ? SHEET_NAME_ENV
                 : (wb.SheetNames.find(n=>/FOB|Master/i.test(n)) || wb.SheetNames[0]);
  const ws = wb.Sheets[sheetName] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) return state;
  state.sheetName = sheetName;

  const HEADER_ROW = autodetectHeaderRow(ws);
  state.headerRow = HEADER_ROW;

  const headers = xlsx.utils.sheet_to_json(ws,{header:1,range:HEADER_ROW-1,raw:false,blankrows:false})[0] || [];
  const rows    = xlsx.utils.sheet_to_json(ws,{header:headers,range:HEADER_ROW,raw:false,defval:'',blankrows:false});
  state.headers = headers;
  if (!rows.length) return state;

  state.items = rows.map(row=>{
    const model = String(pick(row, A_MODEL) || '').trim();
    if (!model) return null;

    const fromXls   = String(pick(row, A_IMAGE) || '').trim();
    const image     = catalogImageFor(model, fromXls); // SOLO Cloudinary (con fallback a Excel URL y luego dummy)

    const shortDesc = String(pick(row, A_SHORT) || '').trim();
    const nameLong  = String(pick(row, A_NAME_LONG) || '').trim();
    const packaging = String(pick(row, A_PACKAGING_TYPE) || '').trim();
    const masterPack= String(pick(row, A_MASTER_PACK) || '').trim();

    // —— precios por comprador (FOB/PVP) ——
    const prices = {};
    for (const [buyer, cfg] of Object.entries(BUYER_PRICE_MAP)) {
      const fob = toNumber(pick(row, cfg.FOB || []));
      const pvp = toNumber(pick(row, cfg.PVP || []));
      prices[buyer] = {
        fob: Number.isFinite(fob) ? +fob.toFixed(2) : null,
        pvp: Number.isFinite(pvp) ? +pvp.toFixed(2) : null,
      };
    }

    // Base compat
    const precioBase = prices['SORIANA']?.fob ?? null;
    const pvpBase    = prices['SORIANA']?.pvp ?? null;

    const details = {
      '2026 model'            : model,
      'Item Description'      : nameLong,
      'Short description'     : shortDesc,
      'CBMs x piece'          : String(pick(row, A_CBM_PER_PIECE)||'').trim(),
      'Packaging type'        : packaging,
      'Bulb Tech'             : String(pick(row, A_BULB_TECH)||'').trim(),
      '# of Bulbs'            : String(pick(row, A_NUM_BULBS)||'').trim(),
      'Color Bulb'            : String(pick(row, A_COLOR_BULB)||'').trim(),
      'Wire Color'            : String(pick(row, A_WIRE_COLOR)||'').trim(),
      'Total Length (m)'      : String(pick(row, A_TOTAL_LENGTH_M)||'').trim(),
      'Master Pack'           : masterPack,
      'Power supply'          : String(pick(row, A_POWER_SUPPLY)||'').trim(),
      'Lighted Length (m)'    : String(pick(row, A_LIGHTED_LENGTH_M)||'').trim(),
      'Lead in (m)'           : String(pick(row, A_LEAD_IN_M)||'').trim(),
      'Lead out (m)'          : String(pick(row, A_LEAD_OUT_M)||'').trim(),
      'End connector'         : String(pick(row, A_END_CONNECTOR)||'').trim(),
      'Function (#)'          : String(pick(row, A_FUNCTIONS)||'').trim(),
      'Included accessories'  : String(pick(row, A_INCLUDED_ACC)||'').trim(),
    };

    return {
      model,
      image,
      short: shortDesc || nameLong,
      packagingType: packaging,
      masterPack,
      name: nameLong,
      priceSoriana: (precioBase!=null) ? +precioBase : null,
      pvpSoriana:   (pvpBase!=null)    ? +pvpBase    : null,
      prices,
      details,
      raw: row
    };
  }).filter(Boolean);

  return state;
}

async function refreshCatalog(){
  try{
    const buf=await fetchExcelBuffer();
    fs.writeFileSync(CATALOG_XLSX,buf);
    CATALOG=loadCatalog();
    console.log('Catálogo cargado:', CATALOG.items.length, 'productos. Hoja:', CATALOG.sheetName, 'HeaderRow:', CATALOG.headerRow);
  }catch(e){ console.error('Error cargando catálogo:', e.message); }
}

// ========= APIs =========
app.get('/api/catalog_for_client', (_,res)=> res.json(CATALOG));

app.get('/api/products', (req,res)=>{
  const q=String(req.query.q||'').trim().toLowerCase();
  let items=CATALOG.items;
  if (q){
    items=items.filter(p =>
      p.model.toLowerCase().includes(q) ||
      (p.name||'').toLowerCase().includes(q) ||
      (p.short||'').toLowerCase().includes(q)
    );
  }
  res.json({ ok:true, items: items.slice(0,200) });
});

app.post('/api/reload', async (_,res)=>{ await refreshCatalog(); res.json({ ok:true, count: CATALOG.items.length }); });

// Ejecutar script Python (incremental) y NO esperar a que termine para responder
app.post('/api/reload_images', (req, res) => {
  try {
    const py = spawn('python3', ['extract_and_upload_images_by_model_incremental.py'], { cwd: __dirname });
    py.stdout.on('data', d => process.stdout.write(d.toString()));
    py.stderr.on('data', d => process.stderr.write(d.toString()));
    py.on('close', code => console.log('Imagenes: proceso python finalizado con código', code));
    res.json({ ok:true, message: 'Script de imágenes lanzado.' });
  } catch (e) {
    console.error('No se pudo lanzar el script de imágenes:', e);
    res.status(500).json({ ok:false, error:'No se pudo lanzar el script de imágenes.' });
  }
});

app.post('/api/interactions', (req,res)=>{
  const { buyer, model, action, note, device, price } = req.body || {};
  if (!buyer || !model || !action) return res.status(400).json({ ok:false, error:'Campos obligatorios faltantes' });
  const now=new Date().toISOString();
  const line=[now,buyer,model,action,(note||'').replace(/[\n\r,]/g,' '),device||'',price??''].join(',')+'\n';
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH,'time,buyer,model,action,note,device,price\n','utf8');
  fs.appendFileSync(CSV_PATH,line,'utf8'); res.json({ ok:true });
});

// ========= APIs de carrito =========
app.get('/api/cart', (req,res)=> res.json({ ok:true, items: cartOf(String(req.query.buyer||'').trim()) }));
app.get('/api/cart/count', (req,res)=> res.json({ ok:true, count: cartOf(String(req.query.buyer||'').trim()).length }));
app.post('/api/cart/add', (req,res)=>{
  const { buyer, item } = req.body || {};
  if (!buyer || !item?.model) return res.status(400).json({ ok:false, error:'buyer e item.model requeridos' });
  const cart=cartOf(buyer); const i=cart.findIndex(x=>x.model===item.model);
  if (i>=0) cart[i] = { ...cart[i], ...item }; else cart.push(item);
  saveCarts(); res.json({ ok:true, items: cart });
});
app.post('/api/cart/remove', (req,res)=>{
  const { buyer, model } = req.body || {};
  if (!buyer || !model) return res.status(400).json({ ok:false, error:'buyer y model requeridos' });
  CARTS[buyer] = cartOf(buyer).filter(x=>x.model!==model); saveCarts();
  res.json({ ok:true, items: CARTS[buyer] });
});
app.post('/api/cart/clear', (req,res)=>{
  const { buyer } = req.body || {};
  if (!buyer) return res.status(400).json({ ok:false, error:'buyer requerido' });
  CARTS[buyer] = []; saveCarts(); res.json({ ok:true, items: [] });
});

// ======== Agregar producto personalizado =========
app.post('/api/cart/add_custom', async (req, res) => {
  try {
    const { buyer, item } = req.body;
    if (!buyer || !item?.model) {
      return res.status(400).json({ ok: false, error: 'El nombre del producto es obligatorio.' });
    }

    let imagePath = '';
    if (item.imageBase64) {
      const matches = item.imageBase64.match(/^data:(image\/.+?);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ ok: false, error: 'Formato de imagen base64 inválido.' });
      }

      const mimeType = matches[1];
      const base64Data = matches[2];
      const buffer = Buffer.from(base64Data, 'base64');

      let finalBuffer = buffer;
      let filename = `CUSTOM_${Date.now()}`;
      const ext = (mimeType.split('/')[1] || '').toLowerCase();
      const supported = ['jpeg','jpg','png'];

      if (!supported.includes(ext) && Sharp) {
        finalBuffer = await Sharp(buffer).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
        filename += '.png';
      } else {
        filename += `.${ext || 'jpg'}`;
      }

      const filePath = path.join(IMAGE_LOCAL_DIR, filename);
      fs.writeFileSync(filePath, finalBuffer);
      imagePath = `/images/${filename}`;
    }

    const customItem = {
      model: item.model,
      note: item.note || '',
      image: imagePath,     // esta ruta se usará también en PDF
      isCustom: true,
      short: item.note || '',
      price: null,
      pvp: null,
    };

    const cart = cartOf(buyer);
    cart.push(customItem);
    saveCarts();
    res.json({ ok: true, items: cart });
  } catch (e) {
    console.error('Error adding custom item:', e);
    res.status(500).json({ ok: false, error: 'No se pudo agregar el producto personalizado.' });
  }
});

// ========= Descargar PDF del carrito (SIN PRECIOS) =========
app.get('/api/download_cart_pdf', async (req,res)=>{
  try {
    const buyer = String(req.query.buyer||'').trim();
    const cart = cartOf(buyer);
    if (!buyer) return res.status(400).send('buyer requerido');
    if (!cart.length) return res.status(400).send('El carrito está vacío');

    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="seleccion-${buyer}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 45, right: 45 }});
    doc.pipe(res);

    doc.fontSize(18).text('Lumina Showroom 2025 — Selección', { align: 'left' });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#555').text(`Comprador: ${buyer}   ·   Fecha: ${new Date().toLocaleDateString('es-MX', { year:'numeric', month:'long', day:'numeric' })}`);
    doc.moveDown(1.5);
    doc.fillColor('#000');

    const regularItems = cart.filter(item => !item.isCustom);
    const customItems  = cart.filter(item => item.isCustom);
    const itemsByModel = new Map(CATALOG.items.map(p=>[p.model,p]));

    const drawTable = async (items, isCustomSection = false) => {
      const tableLeft = doc.page.margins.left;
      const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const cols = [
        { key:'img',   title:'Imagen',     width: contentWidth * 0.14 },
        { key:'model', title:'Modelo',     width: contentWidth * 0.20 },
        { key:'short', title:'Descripción',width: contentWidth * 0.30 },
        { key:'note',  title:'Comentario', width: contentWidth * 0.36 },
      ];

      const drawHeader = () => {
        const headerY = doc.y;
        let x = tableLeft;
        doc.fontSize(9).fillColor('#374151').font('Helvetica-Bold');
        cols.forEach(c => {
          doc.rect(x, headerY, c.width, 22).fill('#f3f4f6');
          doc.text(c.title, x + 6, headerY + 7, { width: c.width - 12 });
          x += c.width;
        });
        doc.y = headerY + 22;
      };

      drawHeader();
      doc.font('Helvetica').fontSize(9);

      let isOdd = true;
      for (const item of items) {
        const catItem = !isCustomSection ? itemsByModel.get(item.model) : null;

        const shortTxt = item.short || catItem?.short || catItem?.name || '';
        const noteTxt  = item.note || '';

        const hShort = doc.heightOfString(shortTxt, { width: cols[2].width - 12 });
        const hNote  = doc.heightOfString(noteTxt,  { width: cols[3].width - 12 });
        const rowH   = Math.max(84, 16 + Math.max(hShort, hNote));

        if (doc.page.height - doc.y < rowH + 40) {
          doc.addPage();
          drawHeader();
        }

        const rowY = doc.y;
        let x = tableLeft;

        if (isOdd) doc.rect(x, rowY, contentWidth, rowH).fill('#fafafa');
        doc.rect(x, rowY, contentWidth, rowH).stroke('#e5e7eb');
        isOdd = !isOdd;

        // Imagen: si es personalizado usamos su elección; si no, Cloudinary/Excel ya viene en catItem.image
        let imgUrl = isCustomSection ? item.image : (catItem?.image || '');
        try {
          let imgBuffer = null;
          if (imgUrl && imgUrl.startsWith('http')) {
            const resp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 6000 });
            imgBuffer = Buffer.from(resp.data);
          } else if (imgUrl && imgUrl.startsWith('/images/')) {
            imgBuffer = fs.readFileSync(path.join(IMAGE_LOCAL_DIR, imgUrl.replace('/images/','')));
          }
          if (imgBuffer) {
            doc.image(imgBuffer, x + 6, rowY + 6, { fit: [cols[0].width - 12, rowH - 12], align: 'center', valign: 'center' });
          } else {
            throw new Error('No image buffer');
          }
        } catch (e) {
          doc.rect(x + 6, rowY + 6, cols[0].width - 12, rowH - 12).fillAndStroke('#f3f4f6', '#e5e7eb');
          doc.fontSize(8).fillColor('#9ca3af').text('Sin imagen', x + 6, rowY + (rowH/2) - 6, { width: cols[0].width - 12, align: 'center' });
        }

        x += cols[0].width;

        doc.fillColor('#1f2937').text(item.model, x + 6, rowY + 8, { width: cols[1].width - 12 });
        x += cols[1].width;
        doc.text(shortTxt, x + 6, rowY + 8, { width: cols[2].width - 12 });
        x += cols[2].width;
        doc.text(noteTxt,  x + 6, rowY + 8, { width: cols[3].width - 12 });
        doc.y = rowY + rowH;
      }
    };

    if (regularItems.length > 0) await drawTable(regularItems, false);
    if (customItems.length > 0) {
      if (doc.page.height - doc.y < 150) doc.addPage();
      doc.moveDown(2);
      doc.fontSize(14).text('Productos Adicionales', { align: 'left' });
      doc.moveDown(1);
      await drawTable(customItems, true);
    }

    doc.end();
  } catch(e) {
    console.error('PDF generation error general:', e);
    res.status(500).send('Error al generar el PDF.');
  }
});

// ========= Descargar Excel del carrito =========
app.get('/api/download_cart_excel', async (req,res)=>{
  try {
    const buyer = String(req.query.buyer||'').trim();
    if (!buyer) return res.status(400).send('buyer requerido');
    const cart = cartOf(buyer);
    if (!cart.length) return res.status(400).send('El carrito está vacío');

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Selección');

    sheet.columns = [
      { header: 'Modelo',       key: 'model', width: 25 },
      { header: 'Descripción',  key: 'short', width: 60 },
      { header: 'Comentario',   key: 'note',  width: 50 }
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern:'solid', fgColor:{ argb:'FFEEEEEE' } };

    const itemsByModel = new Map(CATALOG.items.map(p=>[p.model,p]));
    for (const item of cart) {
      const catItem = !item.isCustom ? itemsByModel.get(item.model) : null;
      sheet.addRow({
        model: item.model,
        short: item.isCustom ? (item.note||'') : (item.short || catItem?.short || catItem?.name || ''),
        note: item.isCustom ? (item.note||'') : (item.note || '')
      });
    }

    sheet.getColumn('short').alignment = { wrapText: true, vertical: 'top' };
    sheet.getColumn('note').alignment  = { wrapText: true, vertical: 'top' };

    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="seleccion-${buyer}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch(e) {
    console.error('Excel generation error:', e);
    res.status(500).send('Error al generar el Excel.');
  }
});

// ========= UI embebida (SIN backticks internos) =========
app.get('/', (_, res) => {
  const buyersJS = JSON.stringify(BUYERS);
  res.type('html').send(`<!doctype html><html lang="es"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Lumina Showroom 2025</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--brand:#0D9488;--brand-light:#CCFBF1;--danger:#E11D48;--text-primary:#1E293B;--text-secondary:#475569;--border-color:rgba(0,0,0,.1);--bg-card:rgba(255,255,255,.8);--bg-modal:#fff}
  *{box-sizing:border-box} body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:var(--text-primary);font-size:14px}
  #particles-js{position:fixed;inset:0;z-index:-1;background-color:#e2e8f0}
  .wrap{max-width:1280px;margin:0 auto;padding:24px}
  .header-card{background:var(--bg-card);backdrop-filter:blur(10px);border:1px solid var(--border-color);border-radius:12px;padding:24px;margin-bottom:24px}
  .header-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px;margin-top:24px}
  select,input,button{border-radius:8px;border:1px solid var(--border-color);background:rgba(255,255,255,.8);height:40px;padding:0 12px;font-size:14px;outline:none;transition:.2s;color:var(--text-primary)}
  select:focus,input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-light)}
  button{cursor:pointer;font-weight:600}.btn-primary{background:var(--brand);border-color:var(--brand);color:#fff}.btn-ghost{background:transparent}
  .tile{background:var(--bg-card);backdrop-filter:blur(10px);border:1px solid var(--border-color);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px}
  .tile-img{width:100%;height:220px;border-radius:8px;background:#f1f5f9;overflow:hidden}.tile-img img{width:100%;height:100%;object-fit:contain}
  .tile-model{font-size:18px;font-weight:700}.tile-desc{font-size:14px;color:var(--text-secondary);line-height:1.5;min-height:42px}
  .tile-actions{display:flex;gap:10px;margin-top:auto}
  textarea{width:100%;min-height:60px;border-radius:8px;border:1px solid var(--border-color);padding:8px 12px;background:#f8fafc;color:var(--text-primary);font-family:inherit}
  .cart-icon-wrapper{position:fixed;top:24px;right:24px;z-index:1000}
  .cart-icon{width:50px;height:50px;border-radius:50%;background:var(--bg-card);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid var(--border-color)}
  .cart-count{position:absolute;top:-5px;right:-5px;background:var(--danger);font-weight:700;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid var(--bg-modal);color:#fff}
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.3);backdrop-filter:blur(5px);z-index:1001;display:none;align-items:center;justify-content:center}
  .modal-overlay.open{display:flex}
  .modal-content{width:90%;max-width:960px;background:var(--bg-modal);border:1px solid var(--border-color);border-radius:12px;max-height:85vh;display:flex;flex-direction:column}
  .modal-header,.modal-footer{padding:16px 24px;border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center}
  .modal-footer{border-bottom:0;border-top:1px solid var(--border-color);gap:12px;flex-wrap:wrap;justify-content:flex-end}
  .modal-body{padding:24px;overflow-y:auto}
  .cart-item{display:grid;grid-template-columns:70px 1fr auto;gap:16px;align-items:center;background:#f8fafc;padding:16px;border-radius:8px;border:1px solid #e2e8f0;margin-bottom:16px}
  .cart-item-img img{width:100%;height:100%;object-fit:contain}
  .detail-grid{display:grid;grid-template-columns:220px 1fr;gap:20px;align-items:start}
  .detail-hero{background:#f1f5f9;border:1px solid var(--border-color);border-radius:10px;height:220px;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .chip{display:inline-block;border:1px solid #d1d5db;background-color:#f9fafb;padding:4px 10px;border-radius:999px;margin-right:8px;margin-bottom:8px;font-size:12px}
  table.attr{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}
  table.attr th,table.attr td{border-bottom:1px solid #e2e8f0;padding:8px 6px;text-align:left;vertical-align:top}
  table.attr th{width:220px;color:#0f172a;font-weight:600;background:#f8fafc}
  #newProductCard{background:var(--bg-card);border-top:1px solid var(--border-color);margin-top:24px;padding-top:24px;display:grid;gap:16px;align-items:flex-end;}
  #imagePreview{width:100px;height:100px;background:#e2e8f0;border-radius:8px;background-size:cover;background-position:center;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--text-secondary);text-align:center;font-size:12px}
  @media (max-width:640px){#newProductCard{grid-template-columns:1fr}#imagePreview{grid-row:1;justify-self:center}#addNewProductBtn{grid-column:1}}
  @media (min-width:641px){#newProductCard{grid-template-columns:100px 1fr 1fr auto}}
</style>
</head><body>
<div id="particles-js"></div>
<div class="cart-icon-wrapper" id="openCart">
  <div class="cart-icon" title="Ver carrito"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 22c.55 0 1-.45 1-1s-.45-1-1-1-1 .45-1 1 .45 1 1 1Z" stroke="#334155" stroke-width="2"/><path d="M20 22c.55 0 1-.45 1-1s-.45-1-1-1-1 .45-1 1 .45 1 1 1Z" stroke="#334155" stroke-width="2"/><path d="M1 1h4l2.68 13.39c.19.94.95 1.62 1.9 1.61H19.4c.95.01 1.71-.67 1.9-1.61L23 6H6" stroke="#334155" stroke-width="2" stroke-linecap="round"/></svg></div>
  <div class="cart-count" id="cartCount" style="display:none">0</div>
</div>
<div class="wrap">
  <div class="header-card">
    <h1 style="margin:0 0 16px 0;">Lumina Showroom 2025</h1>
    <div class="header-controls">
      <button class="btn-ghost" id="homeBtn">Home</button>
      <select id="buyer"></select>
      <input id="q" placeholder="Buscar por modelo o nombre..." style="flex-grow:1;"/>
      <button class="btn-primary" id="btnbuscar">Buscar</button>
      <button class="btn-ghost" id="reload">Recargar</button>
    </div>

    <div id="newProductCard">
      <div id="imagePreview" title="Haz clic para seleccionar o tomar una foto"><span>+ Añadir Foto</span></div>
      <input type="file" id="newProductImage" accept="image/*" capture="environment" style="display:none" />
      <div>
        <label for="newProductName" style="font-size:12px;color:var(--text-secondary);">Nombre / Modelo</label>
        <input type="text" id="newProductName" placeholder="Ej: Esfera Roja Grande" style="width:100%;margin-top:4px;"/>
      </div>
      <div>
        <label for="newProductNote" style="font-size:12px;color:var(--text-secondary);">Notas / Descripción</label>
        <textarea id="newProductNote" placeholder="Añadir comentario..." style="width:100%;margin-top:4px;height:40px;"></textarea>
      </div>
      <button class="btn-primary" id="addNewProductBtn">Agregar</button>
    </div>
  </div>

  <div id="results" class="grid"></div>
</div>

<div class="modal-overlay" id="cartModal">
  <div class="modal-content">
    <div class="modal-header"><h2>Mi Selección</h2><button class="btn-ghost" id="closeCart">Cerrar</button></div>
    <div class="modal-body" id="cartBody"></div>
    <div class="modal-footer">
      <button class="btn-ghost" id="clearCart">Vaciar</button>
      <div style="flex-grow:1"></div>
      <button class="btn-ghost" id="downloadExcel">Descargar Excel</button>
      <button class="btn-ghost" id="downloadPdf">Descargar PDF</button>
      <button class="btn-primary" id="submitCart">Enviar Selección</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="detailModal">
  <div class="modal-content">
    <div class="modal-header"><h2 id="detailTitle"></h2><button class="btn-ghost" id="closeDetail">Cerrar</button></div>
    <div class="modal-body" id="detailBody"></div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/particles.js@2.0.0/particles.min.js"></script>
<script>
  // NO usar backticks aquí adentro, solo comillas
  const BUYERS = ${buyersJS};
  let currentBuyer = BUYERS[0] || 'SORIANA';
  let CATALOG = { items: [] };

  async function apiCartCount(){ const r = await fetch('/api/cart/count?buyer='+encodeURIComponent(currentBuyer)); const j = await r.json(); return j.count||0; }
  async function apiCartGet(){ const r = await fetch('/api/cart?buyer='+encodeURIComponent(currentBuyer)); const j = await r.json(); return j.items||[]; }
  async function apiCartAdd(item){ await fetch('/api/cart/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({buyer:currentBuyer,item})}); }
  async function apiCartRemove(model){ await fetch('/api/cart/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({buyer:currentBuyer,model})}); }
  async function apiCartClear(){ await fetch('/api/cart/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({buyer:currentBuyer})}); }

  function init(){
    renderBuyer(); setupEventListeners(); updateCartCount();
    fetch('/api/catalog_for_client').then(r=>r.json()).then(d=>{ CATALOG=d||{items:[]}; }).then(()=> buscar());
    setInterval(updateCartCount, 5000);
  }

  function renderBuyer(){
    const sel=document.getElementById('buyer');
    sel.innerHTML = BUYERS.map(function(b){ return '<option '+(b===currentBuyer?'selected':'')+'>'+b+'</option>'; }).join('');
    sel.onchange = async function(){
      currentBuyer = sel.value;
      await updateCartCount();
      await buscar();
      if (document.getElementById('cartModal').classList.contains('open')) {
        await renderCartItems();
      }
    };
  }

  async function buscar(){
    const grid=document.getElementById('results'); grid.innerHTML='<p>Buscando...</p>';
    const q=document.getElementById('q').value.trim();
    const data=await (await fetch('/api/products?q='+encodeURIComponent(q))).json(); grid.innerHTML='';
    if (!data.items||!data.items.length){ grid.innerHTML='<p>No se encontraron productos.</p>'; return; }
    data.items.forEach(function(p){
      const cur = (p.prices && p.prices[currentBuyer]) || {};
      const chipPrecio = (cur.fob!=null) ? '<span class="chip">Precio: $'+Number(cur.fob).toFixed(2)+'</span>' : '';
      const chipPvp    = (cur.pvp!=null) ? '<span class="chip">PVP (Est.): $'+Number(cur.pvp).toFixed(2)+'</span>' : '';

      const card=document.createElement('div'); card.className='tile';
      card.innerHTML =
        '<div class="tile-img">'+(p.image?'<img src="'+p.image+'" alt="'+p.model+'"/>':'')+'</div>'+
        '<div>'+
          '<div class="tile-model">'+p.model+'</div>'+
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 8px 0;">'+
            (p.packagingType?'<span class="chip">Packaging: '+p.packagingType+'</span>':'')+
            (p.masterPack?'<span class="chip">Master Pack: '+p.masterPack+'</span>':'')+
          '</div>'+
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 8px 0;">'+chipPrecio+chipPvp+'</div>'+
          '<div class="tile-desc">'+(p.short || p.name || 'Sin descripción')+'</div>'+
        '</div>'+
        '<textarea class="note" placeholder="Añadir comentario..."></textarea>'+
        '<div class="tile-actions">'+
          '<button class="btn-primary add" data-model="'+p.model+'">Añadir</button>'+
          '<button class="btn-ghost info" data-model="'+p.model+'">Ver más</button>'+
        '</div>';
      grid.appendChild(card);
    });
  }

  async function updateCartCount(){
    const n=await apiCartCount(); const el=document.getElementById('cartCount');
    el.textContent=n; el.style.display = n>0 ? 'flex' : 'none';
  }

  function openCart(){ renderCartItems(); document.getElementById('cartModal').classList.add('open'); }
  function closeCart(){ document.getElementById('cartModal').classList.remove('open'); }

  async function renderCartItems(){
    const body=document.getElementById('cartBody'); const cart=await apiCartGet();
    const prodMap = new Map((CATALOG.items||[]).map(function(p){ return [p.model,p]; }));
    body.innerHTML = cart.length===0?'<p>Tu selección está vacía.</p>':
      cart.map(function(it){
        var priceHtml = '';
        if (!it.isCustom) {
          const prod = prodMap.get(it.model);
          const cur  = (prod && prod.prices && prod.prices[currentBuyer]) || {};
          const chip1 = (cur.fob!=null) ? '<strong>Precio:</strong> $'+Number(cur.fob).toFixed(2) : '';
          const chip2 = (cur.pvp!=null) ? '<strong>PVP (Est.):</strong> $'+Number(cur.pvp).toFixed(2) : '';
          priceHtml = [chip1, chip2].filter(Boolean).join(' · ');
        }
        const desc = it.short || (prodMap.get(it.model)||{}).short || (prodMap.get(it.model)||{}).name || '';
        return (
          '<div class="cart-item">'+
            '<div class="cart-item-img">'+(it.image?'<img src="'+it.image+'" alt="'+it.model+'"/>':'')+'</div>'+
            '<div>'+
              '<div style="font-weight:700;margin-bottom:4px;">'+it.model+(it.isCustom ? ' <span class="chip">Personalizado</span>' : '')+'</div>'+
              '<div style="font-size:12px;margin:4px 0 8px 0;">'+priceHtml+'</div>'+
              '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">'+desc+'</div>'+
              '<textarea class="note edit-note" data-model="'+it.model+'" placeholder="Comentario...">'+(it.note||'')+'</textarea>'+
            '</div>'+
            '<button class="btn-ghost del" data-model="'+it.model+'" title="Quitar">✖</button>'+
          '</div>'
        );
      }).join('');
  }

  async function submitCart(){
    const cart=await apiCartGet(); if (cart.length===0) return alert('No hay artículos en la selección.');
    for (const item of cart){
      await fetch('/api/interactions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({buyer:currentBuyer,model:item.model,action:'selected',note:'',device:navigator.userAgent,price:item.price??''})});
      if (item.note){
        await fetch('/api/interactions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({buyer:currentBuyer,model:item.model,action:'note',note:item.note,device:navigator.userAgent,price:item.price??''})});
      }
    }
    alert('¡Selección enviada con éxito! (El carrito no se vació)');
  }

  function renderDetails(p){
    const cur = (p.prices && p.prices[currentBuyer]) || {};
    const chipPrecio = (cur.fob!=null) ? '<span class="chip">Precio: $'+Number(cur.fob).toFixed(2)+'</span>' : '';
    const chipPvp    = (cur.pvp!=null) ? '<span class="chip">PVP (Est.): $'+Number(cur.pvp).toFixed(2)+'</span>' : '';

    const order = ['2026 model','Item Description','Short description','CBMs x piece','Packaging type','Bulb Tech','# of Bulbs','Color Bulb','Wire Color','Total Length (m)','Master Pack','Power supply','Lighted Length (m)','Lead in (m)','Lead out (m)','End connector','Function (#)','Included accessories'];
    const attributes = order
      .map(function(k){ return [k, (p.details||{})[k] ?? (k === 'Short description' ? p.short : '')]; })
      .filter(function(pair){ return String(pair[1]||'').trim(); })
      .map(function(pair){ return '<tr><th>'+pair[0]+'</th><td>'+pair[1]+'</td></tr>'; }).join('');
    document.getElementById('detailBody').innerHTML =
      '<div class="detail-grid">'+
        '<div class="detail-hero">'+(p.image?'<img src="'+p.image+'" alt="'+p.model+'" style="max-width:100%;max-height:100%;object-fit:contain;">':'')+'</div>'+
        '<div>'+
          '<div style="font-size:22px;font-weight:800;margin-bottom:6px;">'+p.model+'</div>'+
          '<div style="margin-bottom:12px;">'+
            (p.packagingType?'<span class="chip">Packaging: '+p.packagingType+'</span>':'')+
            (p.masterPack?'<span class="chip">Master Pack: '+p.masterPack+'</span>':'')+
            ' '+chipPrecio+' '+chipPvp+
          '</div>'+
          '<table class="attr">'+attributes+'</table>'+
        '</div>'+
      '</div>';
  }

  function showDetails(model){
    const p=(CATALOG.items||[]).find(function(x){ return x.model===model; }); if (!p) return;
    document.getElementById('detailTitle').textContent = p.model;
    renderDetails(p);
    document.getElementById('detailModal').classList.add('open');
  }

  async function downloadFile(url, defaultFilename) {
    try {
      const r = await fetch(url);
      if (!r.ok) { alert('Error al descargar: '+(await r.text())); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = defaultFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert('No se pudo descargar el archivo. Revise la consola del navegador.');
      console.error('Download error:', e);
    }
  }

  function setupEventListeners(){
    document.getElementById('homeBtn').onclick = async function(){ document.getElementById('q').value=''; await buscar(); };
    document.getElementById('btnbuscar').onclick = async function(){ await buscar(); };

    document.getElementById('q').addEventListener('keydown', async function(e){
      if (e.key==='Enter') buscar();
    });

    document.getElementById('reload').onclick = async function(){
      const btn=document.getElementById('reload'); const old=btn.textContent; btn.textContent='...'; btn.disabled = true;
      await fetch('/api/reload_images', { method:'POST' });
      await fetch('/api/reload',{method:'POST'});
      const d = await (await fetch('/api/catalog_for_client')).json();
      CATALOG = d || { items: [] };
      await buscar();
      btn.textContent=old; btn.disabled = false;
    };

    document.getElementById('openCart').onclick = function(){ openCart(); };
    document.getElementById('closeCart').onclick = closeCart;
    document.getElementById('submitCart').onclick = submitCart;
    document.getElementById('clearCart').onclick = async function(){
      if (confirm('¿Seguro que quieres vaciar toda la selección?')){
        await apiCartClear(); await renderCartItems(); await updateCartCount();
      }
    };

    document.getElementById('results').addEventListener('click', async function(e){
      const btn=e.target.closest('button'); if (!btn) return;
      const model=btn.dataset.model; if (!model) return;
      const p=(CATALOG.items||[]).find(function(x){ return x.model===model; });
      if (btn.classList.contains('add')){
        const tile=btn.closest('.tile'); const note=(tile.querySelector('.note')||{}).value?.trim()||'';
        const cur = (p && p.prices && p.prices[currentBuyer]) || {};
        await apiCartAdd({ model:model, note:note, short:(p?(p.short||p.name):''), image:(p&&p.image)||'', price:(cur.fob!=null)?cur.fob:null, pvp:(cur.pvp!=null)?cur.pvp:null });
        await updateCartCount();
        await renderCartItems();
      }
      if (btn.classList.contains('info')) showDetails(model);
    });

    document.getElementById('cartBody').addEventListener('click', async function(e){
      const btn=e.target.closest('button.del'); if (btn){
        await apiCartRemove(btn.dataset.model); await renderCartItems(); await updateCartCount();
      }
    });
    document.getElementById('cartBody').addEventListener('input', async function(e){
      if (e.target.classList.contains('edit-note')){
        const model=e.target.dataset.model; const items=await apiCartGet();
        const it=items.find(function(i){ return i.model===model; }); if (it){ it.note=e.target.value; await apiCartAdd(it); }
      }
    });

    document.getElementById('downloadPdf').onclick = function(){ downloadFile('/api/download_cart_pdf?buyer=' + encodeURIComponent(currentBuyer), 'seleccion-'+currentBuyer+'.pdf'); };
    document.getElementById('downloadExcel').onclick = function(){ downloadFile('/api/download_cart_excel?buyer=' + encodeURIComponent(currentBuyer), 'seleccion-'+currentBuyer+'.xlsx'); };

    var imagePreview = document.getElementById('imagePreview');
    var imageInput = document.getElementById('newProductImage');
    var addBtn = document.getElementById('addNewProductBtn');
    var nameInput = document.getElementById('newProductName');
    var noteInput = document.getElementById('newProductNote');
    var imageBase64 = '';

    imagePreview.onclick = function(){ imageInput.click(); };
    imageInput.onchange = function(){
      var file = imageInput.files[0];
      if (file) {
        var reader = new FileReader();
        reader.onload = function(e){
          imageBase64 = e.target.result;
          imagePreview.style.backgroundImage = 'url('+imageBase64+')';
          imagePreview.querySelector('span').style.display = 'none';
        };
        reader.readAsDataURL(file);
      }
    };

    addBtn.onclick = async function(){
      var model = nameInput.value.trim();
      if (!model) { alert('Por favor, añade un nombre o modelo para el producto personalizado.'); return; }
      addBtn.textContent = 'Agregando...';
      addBtn.disabled = true;
      await fetch('/api/cart/add_custom', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ buyer: currentBuyer, item: { model:model, note: noteInput.value.trim(), imageBase64: imageBase64 } }) });
      nameInput.value=''; noteInput.value=''; imageInput.value=''; imagePreview.style.backgroundImage=''; imagePreview.querySelector('span').style.display='block'; imageBase64='';
      addBtn.textContent = 'Agregar'; addBtn.disabled = false;
      await updateCartCount(); await renderCartItems(); alert('Producto personalizado agregado a la selección.');
    };
  }
  document.addEventListener('DOMContentLoaded', init);

  particlesJS("particles-js",{"particles":{"number":{"value":80,"density":{"enable":true,"value_area":800}},"color":{"value":"#94a3b8"},"shape":{"type":"circle"},"opacity":{"value":0.5,"random":true},"size":{"value":3,"random":true},"line_linked":{"enable":true,"distance":150,"color":"#cbd5e1","opacity":0.4,"width":1},"move":{"enable":true,"speed":1,"direction":"none","out_mode":"out"}},"interactivity":{"detect_on":"canvas","events":{"onhover":{"enable":true,"mode":"grab"},"onclick":{"enable":true,"mode":"push"}}}});
</script>
</body></html>`);
});

// ====== start ======
app.listen(PORT, async () => {
  await refreshCatalog();
  console.log(`🚀 Servidor Lumina Showroom escuchando en http://localhost:${PORT}`);
});
