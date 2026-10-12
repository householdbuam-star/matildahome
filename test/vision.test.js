import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractTokens } from '../server/vision/ocr.js';
import { barcodeVariants } from '../server/vision/barcode.js';
import { openDatabase } from '../server/db.js';
import { importItems } from '../server/importer.js';

test('extractTokens keeps codes and brand words, drops noise, adds variants', () => {
  const toks = extractTokens('BINATONE\nAIR COOLER\nModel: BAC-201\nMade in China  220V 50Hz\nDXB-20976-2');
  const names = toks.map((t) => t.token);
  assert.ok(names.includes('BAC-201'));
  assert.ok(names.includes('BINATONE'));
  assert.ok(names.includes('DXB-20976'), 'suffix stripped variant');
  assert.ok(!names.includes('CHINA'), 'stop word removed');
  assert.ok(!names.includes('MADE'));
  assert.equal(toks[0].score, 3, 'model numbers rank first');
});

test('barcodeVariants covers UPC-A / EAN-13 zero padding', () => {
  assert.deepEqual(barcodeVariants('012345678905').sort(), ['0012345678905', '012345678905', '12345678905'].sort());
  assert.deepEqual(barcodeVariants('6291234567894'), ['6291234567894']);
});

test('images table gains an embedding column on open', () => {
  const db = openDatabase(':memory:');
  const cols = db.prepare('PRAGMA table_info(images)').all().map((c) => c.name);
  assert.ok(cols.includes('embedding'));
});

after(async () => { const { shutdownVision } = await import('../server/vision/index.js'); await shutdownVision(); });

const modelDir = path.resolve(process.env.MODEL_DIR || 'data/models', 'mobilenet');
const hasModel = fs.existsSync(path.join(modelDir, 'model.json'));

test('identify finds the SKU from a photo of the label', { skip: !hasModel && 'MobileNet files not present' }, async () => {
  const { PhotoIndex, identify } = await import('../server/vision/index.js');
  const sharp = (await import('sharp')).default;
  const db = openDatabase(':memory:');
  importItems(db, [
    { sku: 'BINAAIRCOBAC-201', description: 'BINATONE AIR COOLER BAC-201', description2: 'BAC-201', brand: 'BINAT', category: 'AC Air cooler', barcode: '6291234567894' },
    { sku: 'DXB-20976', description: '20976-INCENSE BURNER', brand: 'DUBAI', category: 'Accessories' },
  ]);
  const index = new PhotoIndex(db);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400"><rect width="100%" height="100%" fill="#eee"/>
    <text x="40" y="120" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="64" fill="#111">BINATONE</text>
    <text x="40" y="240" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="64" fill="#111">Model: BAC-201</text></svg>`;
  const photo = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  const r = await identify(db, index, photo);
  assert.ok(r.text.tokens.includes('BAC-201'), `tokens: ${r.text.tokens}`);
  assert.equal(r.text.items[0].item.sku, 'BINAAIRCOBAC-201');
  assert.equal(r.similar.length, 0, 'no catalog photos indexed yet');
});
