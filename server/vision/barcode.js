// Decodes barcodes (EAN/UPC/Code128/QR...) that are visible in a photo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

let readyPromise = null;
async function getReader() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const zx = await import('zxing-wasm/reader');
      const wasmFile = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('zxing-wasm/reader'))), '../../reader/zxing_reader.wasm');
      zx.prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(wasmFile).buffer }, fireImmediately: true });
      return zx;
    })().catch((e) => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

const FORMATS = ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'Code39', 'Code93', 'ITF', 'QRCode', 'DataMatrix'];

/** Returns the decoded barcode strings found in the image (deduplicated, may be empty). */
export async function readBarcodes(buffer) {
  const zx = await getReader();
  const { data, info } = await sharp(buffer).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const results = await zx.readBarcodes({ data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height }, { tryHarder: true, tryRotate: true, tryInvert: true, formats: FORMATS, maxNumberOfSymbols: 4 });
  const out = [];
  for (const r of results) {
    const text = String(r.text || '').trim();
    if (text && !out.some((o) => o.text === text)) out.push({ text, format: r.format });
  }
  return out;
}

/** Variants of a decoded code that may be how it is stored in the catalog (UPC-A vs EAN-13 etc). */
export function barcodeVariants(code) {
  const v = new Set([code]);
  if (/^\d+$/.test(code)) {
    v.add(code.replace(/^0+/, ''));
    if (code.length === 12) v.add('0' + code);
    if (code.length === 13 && code.startsWith('0')) v.add(code.slice(1));
  }
  return [...v].filter(Boolean);
}
