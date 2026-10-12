# Matilda Home SKU Catalog

A small website where showroom managers search any SKU and immediately see its **picture**, description, brand, category, stock and **retail price**. Cost prices (average cost, cost in NGN, margin) are only visible after logging in as admin. They are stripped on the server, so they never reach a visitor's browser.

- Search by SKU, description, barcode or brand (partial matches work, e.g. `20989` finds `DXB-20989/1`).
- One tab per brand: press a brand (for example DANNY) to see all of its SKUs. Also filter by category, in stock, with photo.
- Item page with photo gallery and a shareable link, e.g. `/item/DXB-20976`.
- Admin: import the Sage X3 item list (.xlsx or .csv), upload photos per item, or bulk upload photos named after their SKU.
- **Snap to find**: no code on the item? Take a photo of it and the site returns the most likely SKUs by reading its barcode, any printed model number, and comparing its look with catalog photos.
- Works on phones and tablets.

## Run it locally

Requires Node.js 22.5 or newer.

```bash
npm install
cp .env.example .env            # then set ADMIN_PASSWORD and SESSION_SECRET
npm run import -- "Item list.xlsx"
npm start                       # http://localhost:3000
```

The `.env` file is not read automatically. Either export the variables in your shell, or start with `node --env-file=.env --no-warnings=ExperimentalWarning server/index.js`.

Admin login uses `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD`. If no password is set, admin login is disabled and the site is read-only for everyone.

## Importing the item list

Either run `npm run import -- "path/to/file.xlsx"` on the server, or log in as admin, open **Admin → Import item list…** and upload the file. Both accept the Sage X3 export as is. Column names are matched loosely; the recognised ones are:

| Field in the catalog | Column names understood |
| --- | --- |
| SKU | Product, SKU, Item code, Code |
| Description | Description 1, Description, Name |
| Extra descriptions | Description 2, Description 3 |
| Category | Catagory / Category name (display), Category (code) |
| Brand, Type, Site, Unit, Volume, Barcode code | same names |
| Stock | QTY on Hand, Availible QTY, PO qty |
| Retail price (public) | Retail Price, Price, Selling price |
| Cost (admin only) | Average cost, AVG in NGN, Percentage |

Re-importing updates existing SKUs, adds new ones and keeps all photos. Tick **Remove SKUs that are not in this file** to also delete discontinued items.

Add `--remove-missing` to the command line import for the same effect.

## Adding photos

- **One item**: open the item as admin and drop images onto *Add photos*. The first photo is the main one; you can change that or delete photos from the gallery.
- **Many at once**: **Admin → Bulk upload photos…** and drop a whole folder of images. Each file is matched to a SKU by its name, ignoring case, spaces and punctuation:
  - `DXB-20976.jpg` → `DXB-20976`
  - `DXB-20989_1.jpg` or `dxb-20989-1.jpg` → `DXB-20989/1` (a slash can be written as `-` or `_`)
  - `DXB-20976-2.jpg`, `DXB-20976 (2).jpg` → a second photo for `DXB-20976`
  - The report lists any file that did not match a SKU.

Large photos are downscaled in the browser to 1600 px before upload, so phone photos upload quickly.

## Snap to find (search by photo)

Press **Snap** next to the search box, take a photo (or pick one from the gallery) and the server combines three signals:

| Signal | How | Works when |
| --- | --- | --- |
| Barcode | ZXing decodes EAN/UPC/Code128/QR codes in the photo and looks up the catalog's *Barcode code* column | the barcode is in the shot, flat and sharp |
| Text on the item | Tesseract reads printed text; model numbers such as `BAC-201` or `DC1483` are searched against SKUs and descriptions | the label, sticker or box is readable |
| Looks similar | MobileNet turns the photo into a fingerprint and compares it with every catalog photo | the item already has a photo in the catalog |

Results are grouped under those three headings and say why each SKU matched. Everything runs on the server, no cloud service required. The MobileNet model (17 MB) is downloaded once into `MODEL_DIR` on first start (from `storage.googleapis.com`), and the Dockerfile prefetches it at build time. Set `VISUAL_SEARCH=0` to turn the feature off.

The "looks similar" results only get good once showroom photos are uploaded, because it compares with those photos. The more angles per item, the better. Photos are indexed in the background right after upload.

**Optional: let Claude read the item.** Phone photos of boxes and labels are messy, and Claude reads them far better than plain OCR (brand, model numbers, what the item is). Set `ANTHROPIC_API_KEY` to turn this on; the result is merged into the "text on the item" matches. It uses `claude-opus-5-5` by default (`CLAUDE_MODEL` to change) and costs roughly a cent per photo. Without the key the feature works with OCR only.

## Deploying

The app is a single Node process with a SQLite database and a photos folder, both under `DATA_DIR` (default `./data`). Mount a persistent disk there in production.

**Docker**

```bash
docker build -t matildahome-catalog .
docker run -d -p 3000:3000 -v catalog-data:/data \
  -e ADMIN_PASSWORD=choose-a-strong-one -e SESSION_SECRET=$(openssl rand -hex 32) \
  matildahome-catalog
```

**Render, Railway, Fly.io or a VPS**: use the Dockerfile or `npm start`, set the environment variables from `.env.example`, attach a persistent volume at `DATA_DIR`, and set `TRUST_PROXY=1` so the admin cookie is marked secure behind the platform's HTTPS.

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `3000` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin login. Empty password disables admin. | `admin` / empty |
| `SESSION_SECRET` | Signs the admin cookie. Set it, or logins reset on restart. | random |
| `SESSION_HOURS` | Admin session length | `12` |
| `TRUST_PROXY` | `1` when behind an HTTPS proxy | `0` |
| `SITE_NAME` | Name in the header | `Matilda Home Catalog` |
| `RETAIL_CURRENCY`, `COST_CURRENCY`, `COST_LOCAL_CURRENCY` | Symbols shown | `₦`, `$`, `₦` |
| `DATA_DIR` | Database and photos | `./data` |
| `MAX_IMAGE_MB`, `MAX_IMPORT_MB` | Upload limits | `12`, `60` |
| `VISUAL_SEARCH` | `0` turns Snap to find off | `1` |
| `MODEL_DIR` | Where the MobileNet files live | `DATA_DIR/models` |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` | Optional Claude reading of the photo | empty, `claude-opus-5-5` |

## Project layout

```
server/index.js     Express app and API routes
server/catalog.js   Search, item lookup, photo-to-SKU matching
server/importer.js  Excel/CSV parsing and upsert
server/auth.js      Admin login, signed cookie, login throttle
server/db.js        SQLite schema (node:sqlite, no native build step)
server/vision/      Snap to find: barcode (zxing-wasm), OCR (tesseract.js), MobileNet embeddings (tfjs), optional Claude
public/             Static front end (no build step)
scripts/import.js   Command line import
test/               node --test suites (npm test)
```

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/items?q=&category=&brand=&inStock=1&hasImage=1&page=&limit=` | Paginated search. Cost fields only for admin. |
| GET | `/api/items/:sku` | One item with its photos |
| GET | `/api/facets` | Categories and brands with counts |
| GET | `/api/config` | Site name, currencies, whether you are admin |
| POST | `/api/identify` | multipart `photo`; returns barcode, text and similar-photo matches |
| POST | `/api/login`, `/api/logout` | JSON `{username, password}` |
| POST | `/api/admin/import` | multipart `file`, optional `removeMissing=1` |
| POST | `/api/admin/images` | multipart `files[]`, optional `sku` |
| DELETE | `/api/admin/images/:id` | Remove a photo |
| POST | `/api/admin/images/:id/primary` | Make a photo the main one |
