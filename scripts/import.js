#!/usr/bin/env node
// Usage: npm run import -- "path/to/Item list.xlsx" [--remove-missing]
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../server/db.js';
import { parseWorkbook, importItems } from '../server/importer.js';

const args = process.argv.slice(2);
const removeMissing = args.includes('--remove-missing');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run import -- "path/to/Item list.xlsx" [--remove-missing]');
  process.exit(1);
}
const buffer = fs.readFileSync(file);
const parsed = parseWorkbook(buffer, path.basename(file));
console.log(`Sheet "${parsed.sheet}": ${parsed.items.length} items, columns: ${Object.keys(parsed.mapping).join(', ')}`);
const db = openDatabase();
const result = importItems(db, parsed.items, { removeMissing });
console.log(`Inserted ${result.inserted}, updated ${result.updated}, removed ${result.removed}.`);
