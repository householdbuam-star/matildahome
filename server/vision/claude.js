// Optional: ask Claude to read the item (brand, model numbers, what it is). Enabled only when
// ANTHROPIC_API_KEY is set. Far better than OCR at reading boxes and labels in messy photos.
import sharp from 'sharp';
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from '../config.js';

export const claudeEnabled = () => Boolean(ANTHROPIC_API_KEY);
let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk').then(({ default: Anthropic }) => new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 45_000, maxRetries: 1 }));
  }
  return clientPromise;
}

const SYSTEM = `You help showroom staff identify a retail product from a photo so they can look up its stock code.
Read every piece of printed text you can see (brand names, model numbers, product names, codes on labels, boxes or stickers).
Reply with JSON only, no prose, in this exact shape:
{"brand": string|null, "model_numbers": string[], "product_type": string, "keywords": string[], "text_seen": string[]}
- model_numbers: codes exactly as printed (letters, digits, dashes), most prominent first.
- product_type: two to four words, e.g. "air cooler", "incense burner", "dining chair".
- keywords: up to 8 short words likely to appear in a terse stock description (material, colour, size such as 7 inch, capacity such as 0.5L).
- text_seen: other distinct words or numbers printed on the item.
If nothing is readable, still describe the product_type and keywords from its appearance.`;

function extractJson(text) {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** Returns {brand, model_numbers, product_type, keywords, text_seen} or null when disabled/failed. */
export async function describeWithClaude(buffer) {
  if (!claudeEnabled()) return null;
  const client = await getClient();
  const jpeg = await sharp(buffer).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const response = await client.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: 'Identify this product. JSON only.' },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return {
    brand: parsed.brand ? String(parsed.brand).trim() : null,
    model_numbers: arr(parsed.model_numbers),
    product_type: parsed.product_type ? String(parsed.product_type).trim() : '',
    keywords: arr(parsed.keywords),
    text_seen: arr(parsed.text_seen),
  };
}
