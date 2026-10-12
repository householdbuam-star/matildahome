/* SKU catalog front end. Plain JS, no build step. */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { config: null, q: '', category: '', brand: '', inStock: false, hasImage: false, page: 1, pages: 1, currentSku: null, currentItem: null };

  // ---------- helpers ----------
  const fmtNum = (n, digits = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const money = (sym, n, digits = 0) => (n === null || n === undefined ? null : `${sym}${fmtNum(n, digits)}`);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const itemUrl = (sku) => `/item/${encodeURIComponent(sku)}`;
  const imageUrl = (filename) => `/images/${encodeURIComponent(filename)}`;
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------- modals ----------
  function openModal(id) { const m = $(id); m.hidden = false; document.body.style.overflow = 'hidden'; const f = m.querySelector('input:not([type=file]):not([type=checkbox])'); if (f) setTimeout(() => f.focus(), 30); }
  function closeModal(id) { $(id).hidden = true; if (![...document.querySelectorAll('.modal')].some((m) => !m.hidden)) document.body.style.overflow = ''; }
  document.querySelectorAll('.modal').forEach((m) => {
    m.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => {
      closeModal(m.id);
      if (m.id === 'itemModal') { state.currentSku = null; history.pushState({}, '', searchUrl()); }
    }));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal')].find((m) => !m.hidden);
    if (open) { closeModal(open.id); if (open.id === 'itemModal') { state.currentSku = null; history.pushState({}, '', searchUrl()); } }
  });

  // ---------- config / admin state ----------
  async function loadConfig() {
    state.config = await api('/api/config');
    const c = state.config;
    document.title = c.siteName;
    $('siteName').textContent = c.siteName;
    $('stats').textContent = c.stats.items ? `${fmtNum(c.stats.items)} items · ${fmtNum(c.stats.withImages)} with photos` : 'No items yet';
    renderAdminControls();
  }
  function renderAdminControls() {
    const c = state.config;
    const btn = $('adminBtn');
    btn.hidden = !c.adminEnabled;
    btn.textContent = c.isAdmin ? 'Admin ▾' : 'Admin login';
    btn.classList.toggle('btn-admin', c.isAdmin);
    $('adminMenu').hidden = true;
  }
  $('adminBtn').addEventListener('click', () => {
    if (!state.config.isAdmin) return openModal('loginModal');
    $('adminMenu').hidden = !$('adminMenu').hidden;
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.topbar-actions')) $('adminMenu').hidden = true; });
  $('menuImport').addEventListener('click', () => { $('adminMenu').hidden = true; openModal('importModal'); });
  $('menuBulk').addEventListener('click', () => { $('adminMenu').hidden = true; $('bulkReport').innerHTML = ''; $('bulkStatus').textContent = ''; openModal('bulkModal'); });
  $('menuLogout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    await loadConfig(); toast('Logged out'); search(); if (state.currentSku) showItem(state.currentSku);
  });

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    try {
      await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value }) });
      $('loginPass').value = '';
      closeModal('loginModal');
      await loadConfig(); toast('Logged in as admin'); search(); if (state.currentSku) showItem(state.currentSku);
    } catch (err) { $('loginError').textContent = err.message; }
  });

  // ---------- facets ----------
  async function loadFacets() {
    const f = await api('/api/facets');
    const fill = (sel, list, label) => {
      const el = $(sel); const cur = el.value;
      el.innerHTML = `<option value="">${label}</option>` + list.map((x) => `<option value="${esc(x.name)}">${esc(x.name)} (${fmtNum(x.count)})</option>`).join('');
      el.value = cur;
    };
    fill('category', f.categories, 'All categories');
    fill('brand', f.brands, 'All brands');
  }

  // ---------- search ----------
  function searchUrl() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category) p.set('category', state.category);
    if (state.brand) p.set('brand', state.brand);
    if (state.inStock) p.set('inStock', '1');
    if (state.hasImage) p.set('hasImage', '1');
    if (state.page > 1) p.set('page', String(state.page));
    const s = p.toString();
    return s ? `/?${s}` : '/';
  }
  function readStateFromUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || ''; state.category = p.get('category') || ''; state.brand = p.get('brand') || '';
    state.inStock = p.get('inStock') === '1'; state.hasImage = p.get('hasImage') === '1'; state.page = Number(p.get('page')) || 1;
    $('q').value = state.q; $('category').value = state.category; $('brand').value = state.brand; $('inStock').checked = state.inStock; $('hasImage').checked = state.hasImage;
    $('clearBtn').hidden = !state.q;
    const m = location.pathname.match(/^\/item\/(.+)$/);
    state.currentSku = m ? decodeURIComponent(m[1]) : null;
  }

  let searchSeq = 0;
  async function search({ push = true } = {}) {
    const seq = ++searchSeq;
    if (push) history.pushState({}, '', state.currentSku ? itemUrl(state.currentSku) : searchUrl());
    const grid = $('grid');
    if (!grid.children.length) grid.innerHTML = Array.from({ length: 12 }, () => '<div class="card skeleton"><div class="card-image"></div><div class="card-body"><div class="line"></div><div class="line" style="width:60%"></div></div></div>').join('');
    const p = new URLSearchParams({ q: state.q, category: state.category, brand: state.brand, page: String(state.page), limit: '48' });
    if (state.inStock) p.set('inStock', '1');
    if (state.hasImage) p.set('hasImage', '1');
    let data;
    try { data = await api(`/api/items?${p}`); } catch (err) { toast(err.message); return; }
    if (seq !== searchSeq) return;
    state.pages = data.pages;
    renderGrid(data);
  }

  function priceHtml(item, cls) {
    const { retail } = state.config.currencies;
    const v = money(retail, item.retail_price);
    return v ? `<span class="${cls}">${esc(v)}</span>` : `<span class="${cls} none">No retail price</span>`;
  }
  function stockHtml(item) {
    const q = item.qty_on_hand;
    if (q === null || q === undefined) return '';
    return q > 0 ? `<span class="card-stock">${fmtNum(q)} in stock</span>` : '<span class="card-stock out">Out of stock</span>';
  }
  const NO_IMAGE_SVG = '<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M4 18l5-5 3 3 3-3 5 5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

  function renderGrid(data) {
    const grid = $('grid');
    $('empty').hidden = data.total !== 0;
    $('resultCount').textContent = data.total ? `${fmtNum(data.total)} item${data.total === 1 ? '' : 's'}${state.q ? ` for “${state.q}”` : ''}` : '';
    grid.innerHTML = data.items.map((it) => `
      <button class="card" type="button" data-sku="${esc(it.sku)}">
        <div class="card-image">${it.image ? `<img src="${imageUrl(it.image)}" alt="" loading="lazy">` : `<div class="no-image">${NO_IMAGE_SVG}<span>No photo</span></div>`}</div>
        <div class="card-body">
          <span class="card-sku">${esc(it.sku)}</span>
          <span class="card-title">${esc(it.description)}</span>
          <span class="card-meta">${esc([it.brand, it.category].filter(Boolean).join(' · '))}</span>
          ${priceHtml(it, 'card-price')}
          ${stockHtml(it)}
        </div>
      </button>`).join('');
    const pager = $('pager');
    pager.hidden = data.pages <= 1;
    $('pageInfo').textContent = `Page ${data.page} of ${data.pages}`;
    $('prevBtn').disabled = data.page <= 1; $('nextBtn').disabled = data.page >= data.pages;
  }

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card[data-sku]');
    if (card) showItem(card.dataset.sku);
  });
  $('prevBtn').addEventListener('click', () => { state.page = Math.max(1, state.page - 1); search(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('nextBtn').addEventListener('click', () => { state.page = Math.min(state.pages, state.page + 1); search(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

  const onQuery = debounce(() => { state.q = $('q').value.trim(); state.page = 1; $('clearBtn').hidden = !state.q; search(); }, 220);
  $('q').addEventListener('input', onQuery);
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); state.q = $('q').value.trim(); state.page = 1; search(); $('q').blur(); });
  $('clearBtn').addEventListener('click', () => { $('q').value = ''; state.q = ''; state.page = 1; $('clearBtn').hidden = true; search(); $('q').focus(); });
  for (const id of ['category', 'brand', 'inStock', 'hasImage']) {
    $(id).addEventListener('change', () => {
      state.category = $('category').value; state.brand = $('brand').value; state.inStock = $('inStock').checked; state.hasImage = $('hasImage').checked; state.page = 1; search();
    });
  }
  $('brandLink').addEventListener('click', (e) => {
    e.preventDefault(); $('q').value = ''; Object.assign(state, { q: '', category: '', brand: '', inStock: false, hasImage: false, page: 1, currentSku: null });
    $('category').value = ''; $('brand').value = ''; $('inStock').checked = false; $('hasImage').checked = false; $('clearBtn').hidden = true;
    closeModal('itemModal'); search();
  });

  // ---------- item detail ----------
  async function showItem(sku) {
    let item;
    try { item = await api(`/api/items/${encodeURIComponent(sku)}`); } catch (err) { toast(err.message); return; }
    state.currentSku = item.sku; state.currentItem = item;
    history.pushState({}, '', itemUrl(item.sku));
    renderItem(item);
    openModal('itemModal');
  }

  function renderItem(item) {
    const c = state.config; const cur = c.currencies;
    $('itemSku').textContent = item.sku;
    $('itemTitle').textContent = item.description || item.sku;
    const price = $('itemPrice');
    const pv = money(cur.retail, item.retail_price);
    price.textContent = pv ? `${pv}` : 'No retail price set';
    price.classList.toggle('none', !pv);

    const fields = [];
    const descs = [item.description2, item.description3].filter((d) => d && d !== item.description);
    if (descs.length) fields.push(['Also described as', [...new Set(descs)].join(' / ')]);
    if (item.brand) fields.push(['Brand', item.brand]);
    if (item.category) fields.push(['Category', item.category + (item.category_code ? ` (${item.category_code})` : '')]);
    if (item.type) fields.push(['Type', item.type]);
    if (item.barcode) fields.push(['Barcode', item.barcode]);
    if (item.qty_on_hand !== null && item.qty_on_hand !== undefined) fields.push(['Quantity on hand', fmtNum(item.qty_on_hand)]);
    if (item.available_qty !== null && item.available_qty !== undefined && item.available_qty !== item.qty_on_hand) fields.push(['Available', fmtNum(item.available_qty)]);
    if (item.volume !== null && item.volume !== undefined) fields.push(['Volume', `${fmtNum(item.volume, 2)} ${item.unit || ''}`.trim()]);
    $('itemFields').innerHTML = fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

    const adminBox = $('itemAdminBox');
    adminBox.hidden = !c.isAdmin;
    if (c.isAdmin) {
      const a = [];
      a.push(['Average cost', money(cur.cost, item.avg_cost, 2) || '—']);
      a.push([`Cost in ${cur.costLocal === '₦' ? 'NGN' : cur.costLocal}`, money(cur.costLocal, item.avg_cost_ngn, 2) || '—']);
      a.push(['Margin', item.margin_pct === null || item.margin_pct === undefined ? '—' : `${fmtNum(item.margin_pct, 1)} %`]);
      if (item.po_qty) a.push(['On purchase order', fmtNum(item.po_qty)]);
      if (item.site) a.push(['Site', item.site]);
      $('itemAdminFields').innerHTML = a.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    }
    $('itemImageAdmin').hidden = !c.isAdmin;
    $('itemUploadStatus').textContent = '';
    renderGallery(item);
  }

  function renderGallery(item, activeIndex = 0) {
    const main = $('itemMainImage'); const thumbs = $('itemThumbs');
    const imgs = item.images || [];
    if (!imgs.length) {
      main.innerHTML = `<div class="no-image">${NO_IMAGE_SVG}<span>No photo yet</span></div>`; thumbs.innerHTML = ''; return;
    }
    const active = imgs[Math.min(activeIndex, imgs.length - 1)];
    main.innerHTML = `<img src="${imageUrl(active.filename)}" alt="${esc(item.sku)}">`;
    main.querySelector('img').addEventListener('click', (e) => e.target.classList.toggle('zoomed'));
    const admin = state.config.isAdmin;
    thumbs.innerHTML = imgs.map((im, i) => `<button class="thumb ${im.id === active.id ? 'active' : ''}" type="button" data-index="${i}" aria-label="Photo ${i + 1}"><img src="${imageUrl(im.filename)}" alt=""></button>`).join('')
      + (admin ? `<div class="thumb-tools">${imgs.length > 1 && activeIndex !== 0 ? `<button class="btn" type="button" data-primary="${active.id}">Make main photo</button>` : ''}<button class="btn btn-danger" type="button" data-delete="${active.id}">Delete photo</button></div>` : '');
    thumbs.querySelectorAll('.thumb').forEach((b) => b.addEventListener('click', () => renderGallery(item, Number(b.dataset.index))));
    const del = thumbs.querySelector('[data-delete]');
    if (del) del.addEventListener('click', async () => {
      if (!confirm('Delete this photo?')) return;
      try { await api(`/api/admin/images/${del.dataset.delete}`, { method: 'DELETE' }); await refreshItem(); toast('Photo deleted'); } catch (err) { toast(err.message); }
    });
    const prim = thumbs.querySelector('[data-primary]');
    if (prim) prim.addEventListener('click', async () => {
      try { await api(`/api/admin/images/${prim.dataset.primary}/primary`, { method: 'POST' }); await refreshItem(); toast('Main photo updated'); } catch (err) { toast(err.message); }
    });
  }
  async function refreshItem() {
    if (!state.currentSku) return;
    const item = await api(`/api/items/${encodeURIComponent(state.currentSku)}`);
    state.currentItem = item; renderGallery(item); search({ push: false }); loadConfig();
  }
  $('copyLink').addEventListener('click', async () => {
    const url = location.origin + itemUrl(state.currentSku);
    try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link', url); }
  });

  // ---------- image upload (client-side downscale, then POST) ----------
  async function downscale(file, max = 1600, quality = 0.86) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 350 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 2 * 1024 * 1024) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (!blob) return file;
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { return file; }
  }
  async function uploadImages(files, { sku = null, onProgress } = {}) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    const report = { saved: [], unmatched: [], rejected: [] };
    const BATCH = 20;
    for (let i = 0; i < list.length; i += BATCH) {
      const fd = new FormData();
      if (sku) fd.append('sku', sku);
      for (const f of list.slice(i, i + BATCH)) fd.append('files', await downscale(f), f.name);
      onProgress?.(Math.min(i + BATCH, list.length), list.length);
      const r = await api('/api/admin/images', { method: 'POST', body: fd });
      report.saved.push(...r.saved); report.unmatched.push(...r.unmatched); report.rejected.push(...r.rejected);
    }
    return report;
  }
  function wireDropzone(zoneId, inputId, handler) {
    const zone = $(zoneId); const input = $(inputId);
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); if (e.dataTransfer.files.length) handler(e.dataTransfer.files); });
    input.addEventListener('change', () => { if (input.files.length) handler(input.files); input.value = ''; });
  }
  wireDropzone('itemDropzone', 'itemFiles', async (files) => {
    const status = $('itemUploadStatus');
    try {
      const r = await uploadImages(files, { sku: state.currentSku, onProgress: (n, t) => { status.textContent = `Uploading ${n} of ${t}…`; } });
      status.textContent = r.saved.length ? `${r.saved.length} photo${r.saved.length === 1 ? '' : 's'} added.` : 'Nothing uploaded.';
      if (r.rejected.length) status.textContent += ` ${r.rejected.length} rejected (${r.rejected[0].reason})`;
      await refreshItem();
    } catch (err) { status.textContent = err.message; }
  });
  wireDropzone('bulkDropzone', 'bulkFiles', async (files) => {
    const status = $('bulkStatus'); const rep = $('bulkReport'); rep.innerHTML = '';
    try {
      const r = await uploadImages(files, { onProgress: (n, t) => { status.textContent = `Uploading ${n} of ${t}…`; } });
      status.textContent = `Done: ${r.saved.length} matched, ${r.unmatched.length} unmatched, ${r.rejected.length} rejected.`;
      rep.innerHTML = (r.saved.length ? `<p class="ok">Matched</p><ul>${r.saved.map((s) => `<li>${esc(s.file)} → <strong>${esc(s.sku)}</strong></li>`).join('')}</ul>` : '')
        + (r.unmatched.length ? `<p class="bad">No SKU matches these file names</p><ul>${r.unmatched.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '')
        + (r.rejected.length ? `<p class="bad">Rejected</p><ul>${r.rejected.map((x) => `<li>${esc(x.file)}: ${esc(x.reason)}</li>`).join('')}</ul>` : '');
      loadConfig(); search({ push: false });
    } catch (err) { status.textContent = err.message; }
  });

  // ---------- import ----------
  $('importFile').addEventListener('change', () => { const f = $('importFile').files[0]; $('importFileName').textContent = f ? f.name : 'Choose file'; });
  const importZone = $('importDropzone');
  importZone.addEventListener('dragover', (e) => { e.preventDefault(); importZone.classList.add('drag'); });
  importZone.addEventListener('dragleave', () => importZone.classList.remove('drag'));
  importZone.addEventListener('drop', (e) => { e.preventDefault(); importZone.classList.remove('drag'); if (e.dataTransfer.files[0]) { $('importFile').files = e.dataTransfer.files; $('importFileName').textContent = e.dataTransfer.files[0].name; } });
  $('importForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = $('importFile').files[0];
    $('importError').textContent = '';
    if (!f) { $('importError').textContent = 'Choose a file first.'; return; }
    if ($('removeMissing').checked && !confirm('SKUs that are not in this file will be deleted (their photos too). Continue?')) return;
    const fd = new FormData(); fd.append('file', f); fd.append('removeMissing', $('removeMissing').checked ? '1' : '0');
    $('importSubmit').disabled = true; $('importStatus').textContent = 'Importing… this takes a few seconds for a large list.';
    try {
      const r = await api('/api/admin/import', { method: 'POST', body: fd });
      $('importStatus').textContent = `Imported sheet “${r.sheet}”: ${fmtNum(r.inserted)} new, ${fmtNum(r.updated)} updated${r.removed ? `, ${fmtNum(r.removed)} removed` : ''}.`;
      $('importFile').value = ''; $('importFileName').textContent = 'Choose file';
      await Promise.all([loadConfig(), loadFacets()]); search({ push: false });
    } catch (err) { $('importError').textContent = err.message; $('importStatus').textContent = ''; }
    finally { $('importSubmit').disabled = false; }
  });

  // ---------- boot ----------
  window.addEventListener('popstate', () => {
    readStateFromUrl();
    if (state.currentSku) showItem(state.currentSku); else closeModal('itemModal');
    search({ push: false });
  });
  (async () => {
    readStateFromUrl();
    try { await Promise.all([loadConfig(), loadFacets()]); } catch (err) { toast(err.message); }
    $('category').value = state.category; $('brand').value = state.brand;
    search({ push: false });
    if (state.currentSku) showItem(state.currentSku);
  })();
})();
