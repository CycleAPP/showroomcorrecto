// lib/cart_pdf.js
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

/**
 * Genera un PDF (Buffer) con el contenido del carrito.
 * Columns: Model | Short | FOB USD | PVP MXN | Note
 */
export async function buildCartPdf({ buyer, items, logoUrl }) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 36 }); // 0.5" margin aprox
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      // Header
      if (logoUrl) {
        try {
          // admite archivos locales (path) o URL ya descargada previamente; si quieres logos remotos,
          // podrías descargar y pasar Buffer. Aquí lo dejamos opcional.
        } catch {}
      }

      const now = new Date();
      const dateStr = now.toISOString().replace("T", " ").slice(0, 19);

      doc.fontSize(18).text("Selección de Productos", { align: "left" });
      doc.moveDown(0.5);
      doc.fontSize(11).text(`Comprador: ${buyer}`, { continued: true }).text(`    Fecha: ${dateStr}`);
      doc.moveDown(0.8);

      // Table header
      doc.fontSize(10).fillColor("#111111").text("Model",  { width: 120, continued: true });
      doc.text("Short",                                  { width: 180, continued: true });
      doc.text("FOB USD",                                { width: 70,  continued: true, align: "right" });
      doc.text("PVP MXN",                                { width: 70,  continued: true, align: "right" });
      doc.text("Note",                                   { width: 0 });
      doc.moveTo(doc.x, doc.y + 2).lineTo(559, doc.y + 2).strokeColor("#cccccc").stroke();
      doc.moveDown(0.5);

      // Rows
      const safe = (v) => (v == null ? "" : String(v));
      const money = (n) => (typeof n === "number" && isFinite(n) ? n.toFixed(2) : (n ? String(n) : ""));

      (items || []).forEach((it, idx) => {
        const model = safe(it.model);
        const short = safe(it.short);
        const fob   = money(it.price);
        const pvp   = money(it.pvp);
        const note  = safe(it.note).replace(/\r?\n/g, " ");

        const yBefore = doc.y;

        // Columna 1
        doc.fillColor("#000000").fontSize(10).text(model,  { width: 120, continued: true });

        // Columna 2
        doc.text(short || "—",                             { width: 180, continued: true });

        // Columna 3
        doc.text(fob || "—",                               { width: 70,  continued: true, align: "right" });

        // Columna 4
        doc.text(pvp || "—",                               { width: 70,  continued: true, align: "right" });

        // Columna 5
        doc.text(note || "—",                              { width: 0 });

        doc.moveDown(0.3);
        doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor("#eeeeee").stroke();
        doc.moveDown(0.3);

        // Salto de página si se acerca al final
        if (doc.y > 760) doc.addPage();
      });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/** Nombre de archivo sugerido */
export function buildFilename(buyer = "seleccion") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${buyer.replace(/[^\w\-]+/g, "_")}-${ts}.pdf`;
}
