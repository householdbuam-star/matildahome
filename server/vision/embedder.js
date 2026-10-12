// Image embeddings with MobileNet v1 (TensorFlow.js, WASM backend). Used to find catalog photos
// that look like the photo a manager just took. Model files are fetched once into MODEL_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { MODEL_DIR, MOBILENET_URL } from '../config.js';

export const EMBED_DIM = 1024;
let modelPromise = null;
let tf = null;

async function ensureModelFiles(dir) {
  const manifestPath = path.join(dir, 'model.json');
  if (fs.existsSync(manifestPath)) {
    const json = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const paths = json.weightsManifest.flatMap((g) => g.paths);
    if (paths.every((p) => fs.existsSync(path.join(dir, p)))) return json;
  }
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[vision] downloading MobileNet to ${dir} ...`);
  const res = await fetch(`${MOBILENET_URL}/model.json`);
  if (!res.ok) throw new Error(`Model download failed: ${res.status}`);
  const json = await res.json();
  for (const p of json.weightsManifest.flatMap((g) => g.paths)) {
    const r = await fetch(`${MOBILENET_URL}/${p}`);
    if (!r.ok) throw new Error(`Model download failed for ${p}: ${r.status}`);
    fs.writeFileSync(path.join(dir, p), Buffer.from(await r.arrayBuffer()));
  }
  fs.writeFileSync(manifestPath, JSON.stringify(json));
  console.log('[vision] MobileNet ready');
  return json;
}

function diskHandler(dir, json) {
  return {
    load: async () => {
      const specs = []; const bufs = [];
      for (const g of json.weightsManifest) { specs.push(...g.weights); for (const p of g.paths) bufs.push(fs.readFileSync(path.join(dir, p))); }
      const total = bufs.reduce((n, b) => n + b.length, 0);
      const out = new Uint8Array(total); let o = 0;
      for (const b of bufs) { out.set(b, o); o += b.length; }
      return { modelTopology: json.modelTopology, weightSpecs: specs, weightData: out.buffer };
    },
  };
}

async function loadModel() {
  tf = await import('@tensorflow/tfjs-core');
  await import('@tensorflow/tfjs-backend-cpu');
  const layers = await import('@tensorflow/tfjs-layers');
  try {
    const wasm = await import('@tensorflow/tfjs-backend-wasm');
    wasm.setWasmPaths(path.join(path.dirname(fileURLToPath(import.meta.resolve('@tensorflow/tfjs-backend-wasm'))), '/'));
    await tf.setBackend('wasm');
  } catch (e) {
    console.warn('[vision] WASM backend unavailable, using CPU backend:', e.message);
    await tf.setBackend('cpu');
  }
  await tf.ready();
  const dir = path.join(MODEL_DIR, 'mobilenet');
  const json = await ensureModelFiles(dir);
  const full = await layers.loadLayersModel(diskHandler(dir, json));
  // Output of the global average pooling layer: a 1024-dim description of the picture.
  const model = layers.model({ inputs: full.inputs, outputs: full.getLayer('reshape_1').output });
  return model;
}

export function getModel() {
  if (!modelPromise) modelPromise = loadModel().catch((e) => { modelPromise = null; throw e; });
  return modelPromise;
}

/** Normalised 1024-dim embedding of an image buffer (any format sharp can read). */
export async function embedImage(buffer) {
  const model = await getModel();
  const { data, info } = await sharp(buffer).rotate().resize(224, 224, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return tf.tidy(() => {
    const input = tf.expandDims(tf.sub(tf.div(tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'float32'), 127.5), 1), 0);
    const out = tf.reshape(model.predict(input), [-1]);
    const normed = tf.div(out, tf.norm(out));
    return new Float32Array(normed.dataSync());
  });
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
