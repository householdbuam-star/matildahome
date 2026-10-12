// Reads printed text (model numbers, brand names) off a product photo with Tesseract.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const langPath = path.join(path.dirname(fileURLToPath(import.meta.resolve('@tesseract.js-data/eng/package.json'))), '4.0.0_best_int');
      const worker = await createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none', logger: () => {} });
      await worker.setParameters({ preserve_interword_spaces: '1' });
      return worker;
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

/** Stops the background OCR worker (lets the process exit cleanly). */
export async function shutdownOcr() {
  if (!workerPromise) return;
  const p = workerPromise; workerPromise = null;
  try { const w = await p; await w.terminate(); } catch { /* already gone */ }
}

/** Returns the raw text Tesseract read from the image. */
export async function readText(buffer) {
  const worker = await getWorker();
  // Grayscale + normalise + modest upscale helps small labels on phone photos.
  const prepared = await sharp(buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: false }).grayscale().normalise().png().toBuffer();
  const { data } = await worker.recognize(prepared);
  return data.text || '';
}

const STOP = new Set(['THE', 'AND', 'FOR', 'WITH', 'MADE', 'IN', 'CHINA', 'MODEL', 'MODE', 'NO', 'SIZE', 'COLOR', 'COLOUR', 'ITEM', 'NAME', 'TYPE', 'PCS', 'SET', 'NEW', 'ART', 'REF', 'CODE', 'QTY', 'NET', 'WEIGHT', 'POWER', 'VOLT', 'WATT', 'INPUT', 'OUTPUT', 'WARNING', 'CAUTION', 'PRODUCT', 'PRODUCTS', 'QUALITY', 'HIGH']);

/**
 * Turn OCR text into search tokens. Codes with digits (BAC-201, DC1483, 20976) rank highest,
 * then brand-like words of 4+ letters. Pure junk (single chars, stop words) is dropped.
 */
export function extractTokens(text) {
  const seen = new Map();
  for (const raw of String(text).split(/[\s,;:()[\]{}|"'<>!?*#@=+\\\/]+/)) {
    let t = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (!t) continue;
    const up = t.toUpperCase();
    const hasDigit = /\d/.test(up); const hasAlpha = /[A-Z]/.test(up);
    let score = 0;
    if (hasDigit && hasAlpha && up.length >= 4) score = 3;           // model numbers: BAC-201, DC1483
    else if (hasDigit && up.length >= 4) score = 2;                  // plain numbers: 20976
    else if (hasAlpha && up.length >= 4 && !STOP.has(up)) score = 1; // brand / product words
    if (!score) continue;
    if (/^\d+$/.test(up) && (up.length < 4 || up.length > 14)) continue;
    const key = up;
    if (!seen.has(key) || seen.get(key) < score) seen.set(key, score);
  }
  // Derived variants so a printed "DXB-20976-2" or "BAC201" still finds "DXB-20976" / "BAC-201".
  for (const [token, score] of [...seen.entries()]) {
    if (score < 2) continue;
    const variants = new Set();
    const noSuffix = token.replace(/[-_.]\w{1,2}$/, '');
    if (noSuffix !== token && noSuffix.length >= 4) variants.add(noSuffix);
    const digits = token.match(/\d{4,}/g) || [];
    for (const d of digits) if (d !== token) variants.add(d);
    const dashed = token.replace(/^([A-Z]+)(\d+)$/, '$1-$2');
    if (dashed !== token) variants.add(dashed);
    const undashed = token.replace(/-/g, '');
    if (undashed !== token && /[A-Z]/.test(undashed) && undashed.length >= 5) variants.add(undashed);
    for (const v of variants) if (!seen.has(v)) seen.set(v, score - 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([token, score]) => ({ token, score }));
}
