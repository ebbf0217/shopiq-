// SHOPIQ front end. All data comes from data/*.json, written by scripts/ in GitHub Actions.
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
};
const day = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------- state
const S = { sales: null, arrivals: null, drops: null, news: null, rates: null, krw: store.get('sq_krw') === '1' };

// ---------- money: store currency, or KRW when the toggle is on
function money(v, cur) {
  if (v == null) return '';
  cur = cur || 'USD';
  if (S.krw && S.rates && S.rates[cur] && S.rates.KRW) {
    const krw = Math.round(v / S.rates[cur] * S.rates.KRW / 100) * 100;
    return '₩' + krw.toLocaleString('ko-KR');
  }
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v); }
  catch { return v + ' ' + cur; }
}

// ---------- product card
function card(p) {
  let price = money(p.price, p.currency);
  if (p.old) price = `<s>${money(p.old, p.currency)}</s>${money(p.new, p.currency)}<span class="pct">-${p.pct}%</span>`;
  else if (p.compare && p.compare > p.price) {
    const pct = p.pct || Math.round((1 - p.price / p.compare) * 100);
    price = `<s>${money(p.compare, p.currency)}</s>${money(p.price, p.currency)}<span class="pct">-${pct}%</span>`;
  }
  const meta = p.detected_at ? `<div class="meta">Dropped ${when(p.detected_at)}</div>` : '';
  return `<a class="card" href="${esc(p.url)}" target="_blank" rel="noopener">
    <div class="img">${p.img ? `<img src="${esc(p.img)}" alt="" loading="lazy">` : ''}</div>
    <div class="body"><div class="brand">${esc(p.brand)}</div><div class="title">${esc(p.title)}</div>
    <div class="price">${price}</div>${meta}</div></a>`;
}
const grid = (items, empty) => items.length ? items.map(card).join('') : `<div class="empty">${empty}</div>`;

function chips(el, values, onPick, current = 'all') {
  el.innerHTML = values.map(([v, label]) =>
    `<button class="chip${v === current ? ' on' : ''}" data-f="${esc(v)}">${esc(label)}</button>`).join('');
  el.onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    el.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
    onPick(b.dataset.f);
  };
}

// ---------- sale
function saleItems() {
  const out = [];
  (S.sales?.brands || []).forEach(b => b.top.forEach(t => out.push({ ...t, brand: b.brand, currency: b.currency })));
  return out.sort((a, b) => b.pct - a.pct);
}
function renderSale(f = 'all') {
  const brands = (S.sales.brands || []).filter(b =>
    f === 'all' ? true : /^\d+$/.test(f) ? b.max_pct >= +f : b.cat === f);
  $('s-brands').innerHTML = brands.map(b => `
    <a class="bcard${b.on_sale ? '' : ' zero'}" href="https://${esc(b.domain)}" target="_blank" rel="noopener">
      <div class="name">${esc(b.brand)}</div>
      <div class="big">${b.max_pct}<sup>%</sup></div>
      <div class="sub">${b.on_sale ? `${b.on_sale.toLocaleString()} of ${b.checked.toLocaleString()} items 20%+ off · median ${b.median_pct}%`
                                    : `No 20%+ markdowns in ${b.checked.toLocaleString()} items`}</div>
    </a>`).join('') || '<div class="bcard">No stores in this filter.</div>';
}

// ---------- price drops (main feature)
function renderDrops(f = 'all') {
  const d = S.drops;
  const list = f === 'all' ? d.items : d.items.filter(x => x.brand === f);
  if (list.length) {
    $('d-body').innerHTML = `<div class="grid">${list.map(card).join('')}</div>`;
    return;
  }
  const meanwhile = saleItems().slice(0, 12);
  $('d-body').innerHTML = `
    <div class="empty">
      <b>No price drops in the last 7 days yet.</b><br>
      ${d.products_tracked.toLocaleString()} products are compared every 3 hours. Price tracking started ${day(d.tracking_since)},
      and the last check was ${when(d.fetched_at)}. A drop appears here as soon as any of these products gets 5% cheaper.
      <div class="small">Black Friday sales usually start late November, which is when most drops show up.</div>
    </div>
    ${meanwhile.length ? `<div class="section"><div class="section-h"><h2>Already marked down</h2><a href="#sale">Sale</a></div>
      <div class="grid">${meanwhile.map(card).join('')}</div></div>` : ''}`;
}

// ---------- new in
function renderNew(f = 'all') {
  const blocks = (S.arrivals.brands || []).filter(b => b.items.length && (f === 'all' || b.brand === f));
  const withMeta = b => b.items.map(i => ({ ...i, brand: b.brand, currency: b.currency }));
  if (f !== 'all') {
    const b = blocks[0];
    $('n-body').innerHTML = b ? `<div class="section"><div class="section-h"><h2>${esc(b.brand)}</h2>
      <a href="${esc(b.collection)}" target="_blank" rel="noopener">Open on ${esc(b.domain.replace('www.', ''))}</a></div>
      <div class="grid">${withMeta(b).map(card).join('')}</div></div>` : '';
    return;
  }
  $('n-body').innerHTML = blocks.map(b => `
    <div class="brand-row"><div class="section-h"><h2>${esc(b.brand)}</h2>
      <a href="${esc(b.collection)}" target="_blank" rel="noopener">View all</a></div>
      <div class="row">${withMeta(b).map(card).join('')}</div></div>`).join('');
}
// a few items from every brand, alternating, so no single store fills the page
function newMix(n) {
  const rows = (S.arrivals?.brands || []).map(b => b.items.filter(i => i.img).map(i => ({ ...i, brand: b.brand, currency: b.currency })));
  const out = [];
  for (let i = 0; out.length < n && rows.some(r => r[i]); i++) rows.forEach(r => r[i] && out.length < n && out.push(r[i]));
  return out;
}

// ---------- news
function newsRows(list) {
  return list.map(a => `<a href="${esc(a.url)}" target="_blank" rel="noopener">
    <div class="when">${day(a.date)}<br>${esc(a.source)}</div>
    <div><div class="ttl">${esc(a.title)}</div>${a.brands.map(b => `<span class="tag">${esc(b)}</span>`).join('')}</div>
    <div class="side">Read ↗</div></a>`).join('');
}
function renderNews(f = 'all') {
  const all = S.news.articles || [];
  const list = f === 'all' ? all : f === 'brands' ? all.filter(a => a.brands.length) : all.filter(a => a.topics.includes(f));
  $('w-list').innerHTML = newsRows(list) || '<div class="empty">No headlines in this filter right now.</div>';
}

// ---------- home
function renderHome() {
  const s = S.sales, d = S.drops, a = S.arrivals;
  if (s) {
    const total = s.brands.reduce((n, b) => n + b.on_sale, 0);
    $('t-sale').textContent = total.toLocaleString();
    $('t-sale-d').textContent = `across ${s.brands.length} stores`;
    $('home-sale').innerHTML = grid(saleItems().slice(0, 12), 'No sale data.');
    $('home-sync').textContent = `Last checked ${when(s.fetched_at)} · ${s.brands.reduce((n, b) => n + b.checked, 0).toLocaleString()} products`;
  }
  if (d) {
    $('t-drops').textContent = d.items.length.toLocaleString();
    $('home-drops').innerHTML = d.items.length
      ? `<div class="grid">${d.items.slice(0, 12).map(card).join('')}</div>`
      : `<div class="empty"><b>No price drops yet.</b> ${d.products_tracked.toLocaleString()} products are compared every 3 hours; drops show up here first.</div>`;
  }
  if (a) {
    $('t-new').textContent = a.brands.reduce((n, b) => n + b.items.length, 0).toLocaleString();
    $('home-new').innerHTML = grid(newMix(12), 'No new arrivals.');
  }
  if (S.news) $('home-news').innerHTML = newsRows(S.news.articles.filter(x => x.topics.includes('collab')).slice(0, 5));
}

// ---------- korea cost calculator
function calc() {
  const price = +$('c-price').value || 0;
  const box = $('c-result');
  if (!price) { box.hidden = true; return; }
  const disc = Math.min(+$('c-disc').value || 0, 90);
  const rate = +$('c-cat').value, threshold = +$('c-from').value;
  const [base, perLb] = $('c-fwd').value.split(',').map(Number);
  const wt = +$('c-wt').value || 0.5;
  const sale = price * (1 - disc / 100);
  const duty = sale > threshold ? sale * rate : 0;
  const vat = duty ? (sale + duty) * 0.10 : 0;
  const ship = base || perLb ? base + perLb * wt : 0;
  const total = sale + duty + vat + ship;
  const krw = (S.rates?.KRW) || 1380;
  const row = (k, v, cls = '') => `<div class="${cls}"><span>${k}</span><span>${v}</span></div>`;
  box.hidden = false;
  box.innerHTML =
    (disc ? row('Sale price', `$${sale.toFixed(2)} <s style="color:var(--mu)">$${price.toFixed(2)}</s>`) : row('Price', `$${price.toFixed(2)}`)) +
    row(`Customs duty (${Math.round(rate * 100)}%)`, duty ? `$${duty.toFixed(2)}` : `<span class="free">$0 · under $${threshold}</span>`) +
    (vat ? row('VAT (10%)', `$${vat.toFixed(2)}`) : '') +
    (ship ? row('Forwarding', `$${ship.toFixed(2)}`) : '') +
    row('Total', `₩${Math.round(total * krw).toLocaleString('ko-KR')}`, 'total') +
    `<div style="border:none;color:var(--mu);font-size:11px"><span>$${total.toFixed(2)} at ₩${Math.round(krw).toLocaleString('ko-KR')}/USD</span></div>`;
}

// ---------- routing
const PAGES = ['home', 'drops', 'new', 'sale', 'news', 'korea', 'about'];
function route() {
  const id = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === 'pg-' + id));
  document.querySelectorAll('[data-page]').forEach(a => a.classList.toggle('on', a.dataset.page === id));
  window.scrollTo(0, 0);
}

function rerenderPrices() {
  if (S.sales) { renderSale($('s-filter').querySelector('.on')?.dataset.f || 'all'); $('s-items-grid').innerHTML = grid(saleItems().slice(0, 24), 'No sale data.'); }
  if (S.drops) renderDrops($('d-filter').querySelector('.on')?.dataset.f || 'all');
  if (S.arrivals) renderNew($('n-filter').querySelector('.on')?.dataset.f || 'all');
  renderHome();
}

// ---------- load
const getJSON = path => fetch(path, { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(r.status));

async function init() {
  route();
  window.addEventListener('hashchange', route);

  // theme and currency toggles
  const setTheme = dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('theme-btn').textContent = dark ? '☀' : '☾'; };
  setTheme(store.get('sq_dark') === '1');
  $('theme-btn').onclick = () => { const dark = document.documentElement.dataset.theme !== 'dark'; store.set('sq_dark', dark ? '1' : '0'); setTheme(dark); };
  const setCur = () => { $('cur-btn').textContent = S.krw ? '₩' : '$'; };
  setCur();
  $('cur-btn').onclick = () => { S.krw = !S.krw; store.set('sq_krw', S.krw ? '1' : '0'); setCur(); rerenderPrices(); };

  ['c-price', 'c-disc', 'c-cat', 'c-from', 'c-fwd', 'c-wt'].forEach(id => $(id).addEventListener('input', calc));

  const [sales, arrivals, drops, news, fx] = await Promise.allSettled([
    getJSON('data/sales.json'), getJSON('data/arrivals.json'), getJSON('data/price_drops.json'),
    getJSON('data/news.json'), getJSON('https://open.er-api.com/v6/latest/USD'),
  ]);

  if (fx.status === 'fulfilled' && fx.value.rates) {
    S.rates = fx.value.rates;
    const r = '₩' + Math.round(S.rates.KRW).toLocaleString('ko-KR');
    $('k-rate').textContent = r; $('home-rate').textContent = '1 USD = ' + r;
  }

  if (sales.status === 'fulfilled') {
    S.sales = sales.value;
    $('s-stores').textContent = S.sales.brands.length;
    $('s-items').textContent = S.sales.brands.reduce((n, b) => n + b.on_sale, 0).toLocaleString();
    $('s-sync').textContent = `Last checked ${when(S.sales.fetched_at)}` + (S.sales.failed.length ? ` · ${S.sales.failed.length} store(s) did not answer` : '');
    $('s-filter').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; $('s-filter').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); renderSale(b.dataset.f); };
    renderSale();
    $('s-items-grid').innerHTML = grid(saleItems().slice(0, 24), 'No sale data.');
  }

  if (drops.status === 'fulfilled') {
    S.drops = drops.value;
    S.drops.products_tracked = S.drops.products_tracked || 0;
    $('d-count').textContent = S.drops.items.length.toLocaleString();
    $('d-tracked').textContent = S.drops.products_tracked.toLocaleString();
    $('d-sync').textContent = `Last compared ${when(S.drops.fetched_at)}`;
    $('d-since').textContent = `Tracking since ${day(S.drops.tracking_since)}`;
    const brands = [...new Set(S.drops.items.map(x => x.brand))].sort();
    if (brands.length > 1) chips($('d-filter'), [['all', 'All'], ...brands.map(b => [b, b])], renderDrops);
    renderDrops();
  }

  if (arrivals.status === 'fulfilled') {
    S.arrivals = arrivals.value;
    const brands = S.arrivals.brands.filter(b => b.items.length);
    $('n-brands').textContent = brands.length;
    $('n-sync').textContent = `Last checked ${when(S.arrivals.fetched_at)} · up to ${S.arrivals.per_brand} items per brand`;
    chips($('n-filter'), [['all', 'All brands'], ...brands.map(b => [b.brand, b.brand])], renderNew);
    renderNew();
  }

  if (news.status === 'fulfilled') {
    S.news = news.value;
    $('w-count').textContent = S.news.articles.length;
    $('w-sync').textContent = `Collected ${when(S.news.fetched_at)}`;
    $('w-filter').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; $('w-filter').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); renderNews(b.dataset.f); };
    renderNews();
  }

  renderHome();
}

init();
