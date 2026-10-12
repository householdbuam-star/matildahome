import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PORT = Number(process.env.PORT || 3000);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const SITE_NAME = process.env.SITE_NAME || 'Matilda Home Catalog';
export const RETAIL_CURRENCY = process.env.RETAIL_CURRENCY || '₦';
export const COST_CURRENCY = process.env.COST_CURRENCY || '$';
export const COST_LOCAL_CURRENCY = process.env.COST_LOCAL_CURRENCY || '₦';
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const SESSION_SECRET = process.env.SESSION_SECRET || '';
export const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
export const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
export const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 12);
export const MAX_IMPORT_MB = Number(process.env.MAX_IMPORT_MB || 60);

// Fields that only an authenticated admin may see.
export const ADMIN_ONLY_FIELDS = ['avg_cost', 'avg_cost_ngn', 'margin_pct', 'po_qty', 'site'];

// ---- Snap to find (visual search) ----
export const VISUAL_SEARCH = process.env.VISUAL_SEARCH !== '0';
export const MODEL_DIR = path.resolve(process.env.MODEL_DIR || path.join(DATA_DIR, 'models'));
export const MOBILENET_URL = process.env.MOBILENET_URL || 'https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v1_1.0_224';
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
