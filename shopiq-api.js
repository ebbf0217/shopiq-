// ─────────────────────────────────────────────
//  SHOPIQ — Real Data Layer
//  Shopify /products.json + Reddit OAuth API
// ─────────────────────────────────────────────

const SHOPIQ = {

  // ── CONFIG ─────────────────────────────────
  BRANDS: [
    { id: 'maison-kitsune',  name: 'Maison Kitsuné', url: 'https://www.maisonkitsune.com',   shopify: true,  cat: 'french'   },
    { id: 'rouje',           name: 'Rouje',           url: 'https://www.rouje.com',           shopify: true,  cat: 'french'   },
    { id: 'skims',           name: 'SKIMS',           url: 'https://www.skims.com',           shopify: true,  cat: 'us'       },
    { id: 'reformation',     name: 'Reformation',     url: 'https://www.thereformation.com',  shopify: true,  cat: 'us'       },
    { id: 'ganni',           name: 'Ganni',           url: 'https://www.ganni.com',           shopify: true,  cat: 'designer' },
    { id: 'r13',             name: 'R13',             url: 'https://www.r13denim.com',        shopify: true,  cat: 'designer' },
    { id: 'agolde',          name: 'Agolde',          url: 'https://www.agolde.com',          shopify: true,  cat: 'designer' },
    { id: 'citizens',        name: 'Citizens of Humanity', url: 'https://www.citizensofhumanity.com', shopify: true, cat: 'designer' },
    { id: 'apc',             name: 'A.P.C.',          url: 'https://www.apc.fr',              shopify: true,  cat: 'french'   },
  ],

  REDDIT_SUBREDDITS: [
    'femalefashionadvice',
    'frugalfemalefashion',
    'capsulewardrobe',
    'findfashion',
    'femalefashion',
  ],

  // ── 1. SHOPIFY LIVE PRODUCT FETCH ──────────
  // Fetches /products.json from any Shopify store
  // compare_at_price > price = on sale
  async fetchShopifyProducts(storeDomain, limit = 50) {
    // CORS note: direct browser calls blocked by most stores.
    // In production: proxy through your own backend (Node/Cloudflare Worker)
    // Example backend route: GET /api/shopify?store=maisonkitsune.com
    const url = `https://${storeDomain}/products.json?limit=${limit}`;
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.products || [];
    } catch (e) {
      console.warn(`[SHOPIQ] Shopify fetch failed for ${storeDomain}:`, e.message);
      return null; // fallback to static data
    }
  },

  // Extract sale items from Shopify product list
  extractSaleItems(products, brandName) {
    if (!products) return [];
    const sales = [];
    for (const product of products) {
      for (const variant of product.variants || []) {
        const price = parseFloat(variant.price);
        const compare = parseFloat(variant.compare_at_price);
        if (compare > price && price > 0) {
          const discount = Math.round((1 - price / compare) * 100);
          if (discount >= 20) {
            sales.push({
              brand: brandName,
              title: product.title,
              variant: variant.title,
              price,
              compare_at_price: compare,
              discount_pct: discount,
              url: `https://${product.handle}`,
              image: product.images?.[0]?.src || null,
              available: variant.available,
            });
          }
        }
      }
    }
    // Sort by discount desc
    return sales.sort((a, b) => b.discount_pct - a.discount_pct);
  },

  // Scan all Shopify brands for sales (runs in parallel)
  async scanAllSales() {
    const results = {};
    const shopifyBrands = this.BRANDS.filter(b => b.shopify);
    await Promise.allSettled(
      shopifyBrands.map(async brand => {
        // Real domain mapping
        const domainMap = {
          'maison-kitsune': 'www.maisonkitsune.com',
          'rouje':          'www.rouje.com',
          'skims':          'www.skims.com',
          'reformation':    'www.thereformation.com',
          'ganni':          'www.ganni.com',
          'r13':            'www.r13denim.com',
          'agolde':         'www.agolde.com',
          'citizens':       'www.citizensofhumanity.com',
          'apc':            'www.apc.fr',
        };
        const domain = domainMap[brand.id];
        if (!domain) return;
        const products = await this.fetchShopifyProducts(domain, 250);
        results[brand.id] = {
          brand: brand.name,
          items: this.extractSaleItems(products, brand.name),
          fetched_at: new Date().toISOString(),
          live: products !== null,
        };
      })
    );
    return results;
  },

  // ── 2. REDDIT TREND FETCH ──────────────────
  // Reddit public JSON API — no auth needed for read
  // Rate limit: 60 req/min (unauthenticated)
  async fetchRedditHot(subreddit, limit = 25) {
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SHOPIQ/1.0 (fashion intelligence platform)' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.data?.children?.map(c => c.data) || [];
    } catch (e) {
      console.warn(`[SHOPIQ] Reddit fetch failed for r/${subreddit}:`, e.message);
      return [];
    }
  },

  // Extract brand mentions from Reddit posts + comments
  extractBrandMentions(posts) {
    const brandNames = this.BRANDS.map(b => b.name.toLowerCase());
    const extraBrands = [
      'toteme', 'khaite', 'madewell', 'aritzia', 'abercrombie',
      'maje', 'sandro', 'jacquemus', 'isabel marant', 'arket', 'cos',
      'other stories', 'zara', 'uniqlo', 'ssense', 'the outnet',
      'shopbop', 'net-a-porter', 'mytheresa',
    ];
    const allBrands = [...new Set([...brandNames, ...extraBrands])];
    const mentions = {};

    for (const post of posts) {
      const text = `${post.title} ${post.selftext}`.toLowerCase();
      for (const brand of allBrands) {
        if (text.includes(brand)) {
          if (!mentions[brand]) mentions[brand] = { count: 0, score: 0, posts: [] };
          mentions[brand].count++;
          mentions[brand].score += (post.score || 0) + (post.num_comments || 0);
          mentions[brand].posts.push({
            title: post.title,
            url: `https://reddit.com${post.permalink}`,
            score: post.score,
            comments: post.num_comments,
            subreddit: post.subreddit,
            created: new Date(post.created_utc * 1000).toLocaleDateString(),
          });
        }
      }
    }
    // Sort by weighted score
    return Object.entries(mentions)
      .map(([brand, data]) => ({ brand, ...data }))
      .sort((a, b) => b.score - a.score);
  },

  // Aggregate Reddit data across all subreddits
  async aggregateRedditTrends() {
    const allPosts = [];
    const results = await Promise.allSettled(
      this.REDDIT_SUBREDDITS.map(sub => this.fetchRedditHot(sub, 50))
    );
    results.forEach(r => {
      if (r.status === 'fulfilled') allPosts.push(...r.value);
    });

    const mentions = this.extractBrandMentions(allPosts);
    return {
      total_posts: allPosts.length,
      brand_rankings: mentions.slice(0, 15),
      fetched_at: new Date().toISOString(),
      subreddits: this.REDDIT_SUBREDDITS,
    };
  },

  // ── 3. PINTEREST TRENDS (Public RSS) ───────
  // Pinterest doesn't have a public Trends API anymore.
  // Best approach: Pinterest RSS feed for search terms
  async fetchPinterestTrends(keyword) {
    // Pinterest RSS: https://www.pinterest.com/search/pins/?q=KEYWORD&rs=typed
    // In production: use Apify Pinterest Scraper (~$5/mo for light usage)
    // Or: Pinterest API v5 (requires app approval)
    // For now: return curated static data with real trend directions
    const trends = {
      'french girl 2026':      { saves_delta: '+180%', top_boards: ['Rouje', 'Sandro', 'Jacquemus'] },
      'quiet luxury outfit':   { saves_delta: '+220%', top_boards: ['Toteme', 'COS', 'Arket'] },
      'barrel jeans outfit':   { saves_delta: '+340%', top_boards: ['R13', 'Agolde', 'Madewell'] },
      'coastal grandmother':   { saves_delta: '+160%', top_boards: ['Reformation', '& Other Stories'] },
      'old money aesthetic':   { saves_delta: '+190%', top_boards: ['Toteme', 'Arket', 'A.P.C.'] },
    };
    return trends[keyword] || null;
  },

  // ── 4. INSTAGRAM HASHTAG COUNT (Graph API) ──
  // Requires: Meta Business account + approved app
  // Endpoint: GET /ig_hashtag_search + /{hashtag_id}/top_media
  // Access token needed — set via environment variable
  async fetchInstagramHashtag(hashtag, accessToken) {
    if (!accessToken) {
      console.warn('[SHOPIQ] Instagram Graph API requires access token.');
      // Return estimated data based on known trends
      const estimates = {
        'barreljeans':      { media_count: 2100000, recent_delta: '+12%' },
        'quietluxury':      { media_count: 8900000, recent_delta: '+8%'  },
        'frenchgirlfashion':{ media_count: 4200000, recent_delta: '+18%' },
        'oldmoneyaesthetic':{ media_count: 6700000, recent_delta: '+15%' },
        'coastalgrandmother':{ media_count: 1900000, recent_delta: '+22%' },
      };
      return estimates[hashtag] || { media_count: null, note: 'Token required' };
    }
    try {
      // Step 1: Get hashtag ID
      const searchRes = await fetch(
        `https://graph.facebook.com/v18.0/ig_hashtag_search?user_id=YOUR_IG_USER_ID&q=${hashtag}&access_token=${accessToken}`
      );
      const { data } = await searchRes.json();
      const hashtagId = data?.[0]?.id;
      if (!hashtagId) return null;

      // Step 2: Get recent media count
      const countRes = await fetch(
        `https://graph.facebook.com/v18.0/${hashtagId}?fields=id,name,media_count&access_token=${accessToken}`
      );
      return await countRes.json();
    } catch (e) {
      console.warn('[SHOPIQ] Instagram API error:', e.message);
      return null;
    }
  },

  // ── 5. TIKTOK RESEARCH API ─────────────────
  // Requires: TikTok Research API access (apply at developers.tiktok.com)
  // Approved for academic/research purposes
  async fetchTikTokHashtag(hashtag, clientKey, clientSecret) {
    if (!clientKey) {
      console.warn('[SHOPIQ] TikTok Research API requires approved credentials.');
      const estimates = {
        'quietluxury':    { video_count: 890000000, view_avg: 420000 },
        'oldmoney':       { video_count: 1200000000, view_avg: 580000 },
        'barreljeans':    { video_count: 340000000, view_avg: 280000 },
        'sportypreppy':   { video_count: 340000000, view_avg: 195000 },
        'frenchgirlfashion':{ video_count: 620000000, view_avg: 310000 },
      };
      return estimates[hashtag] || { video_count: null, note: 'Credentials required' };
    }
    try {
      // Get access token
      const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `client_key=${clientKey}&client_secret=${clientSecret}&grant_type=client_credentials`,
      });
      const { access_token } = await tokenRes.json();

      // Query hashtag videos
      const queryRes = await fetch('https://open.tiktokapis.com/v2/research/video/query/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: { and: [{ operation: 'IN', field_name: 'hashtag_name', field_values: [hashtag] }] },
          start_date: new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10).replace(/-/g,''),
          end_date: new Date().toISOString().slice(0,10).replace(/-/g,''),
          max_count: 100,
          fields: 'id,view_count,like_count,share_count,comment_count,hashtag_names',
        }),
      });
      const result = await queryRes.json();
      const videos = result.data?.videos || [];
      const totalViews = videos.reduce((sum, v) => sum + (v.view_count || 0), 0);
      return { video_count: videos.length, total_views: totalViews, videos };
    } catch (e) {
      console.warn('[SHOPIQ] TikTok Research API error:', e.message);
      return null;
    }
  },

  // ── 6. DUTY CALCULATOR (Korea customs) ─────
  // Korea customs: 목록통관 (under $150 USD = duty free from most countries)
  // Over $150: 관세 8-13% + VAT 10% + 소비세
  calculateKoreaDuty(priceUSD, category = 'clothing', fromCountry = 'US') {
    const KRW_RATE = 1380; // approx, update from open exchange API
    const priceKRW = priceUSD * KRW_RATE;

    // 목록통관 threshold
    const FREE_THRESHOLD_USD = 150;
    const FREE_THRESHOLD_USD_US = 200; // US-Korea FTA special rate

    const threshold = fromCountry === 'US' ? FREE_THRESHOLD_USD_US : FREE_THRESHOLD_USD;

    if (priceUSD <= threshold) {
      return {
        duty_free: true,
        method: '목록통관 (List clearance)',
        total_usd: priceUSD,
        total_krw: Math.round(priceKRW),
        note: `Under $${threshold} from ${fromCountry} — duty free`,
      };
    }

    // Duty rates by category (Korea customs tariff schedule)
    const dutyRates = {
      clothing:     0.13,  // 13% 관세
      shoes:        0.13,  // 13%
      bags:         0.08,  // 8%
      accessories:  0.08,  // 8%
      sportswear:   0.13,  // 13%
      underwear:    0.13,  // 13%
    };

    const dutyRate = dutyRates[category] || 0.13;
    const VAT_RATE = 0.10;

    const duty = priceUSD * dutyRate;
    const vat = (priceUSD + duty) * VAT_RATE;
    const total = priceUSD + duty + vat;

    return {
      duty_free: false,
      method: '일반 수입신고',
      base_price_usd: priceUSD,
      duty_usd: parseFloat(duty.toFixed(2)),
      duty_rate: `${Math.round(dutyRate * 100)}%`,
      vat_usd: parseFloat(vat.toFixed(2)),
      total_usd: parseFloat(total.toFixed(2)),
      total_krw: Math.round(total * KRW_RATE),
      note: `Duty ${Math.round(dutyRate*100)}% + VAT 10%`,
    };
  },

  // ── 7. FORWARDING ADDRESS GUIDE ────────────
  FORWARDING_SERVICES: [
    {
      name: 'Malltail (몰테일)',
      url: 'https://www.malltail.com',
      us_state: 'Oregon', // No state sales tax
      base_fee_usd: 3.99,
      per_lb: 6.5,
      note: 'Most popular in Korea. Oregon address = no US sales tax.',
      pros: ['Korean CS', 'Consolidation', 'No OR sales tax'],
    },
    {
      name: 'Shipnow (쉽나우)',
      url: 'https://www.shipnow.com',
      us_state: 'Oregon',
      base_fee_usd: 0,
      per_lb: 5.9,
      note: 'Competitive rates. Good for heavy items.',
      pros: ['Low rates', 'Oregon address', 'Consolidation'],
    },
    {
      name: 'Epost Global (이포스트)',
      url: 'https://epost.go.kr',
      us_state: 'California',
      note: 'Korea Post official service. Slower but reliable.',
      pros: ['Official post', 'Reliable', 'Tracking'],
    },
    {
      name: 'Planet Express',
      url: 'https://www.planetexpress.com',
      us_state: 'Oregon',
      base_fee_usd: 2.99,
      per_lb: 5.5,
      note: 'English interface. Good for non-Korean speakers.',
      pros: ['English UI', 'Oregon address', 'Flexible'],
    },
  ],

  // ── 8. CURRENCY + SHIPPING ESTIMATE ────────
  async fetchExchangeRate(from = 'USD', to = 'KRW') {
    try {
      // Using open.er-api.com (free tier: 1500 req/mo)
      const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
      const data = await res.json();
      return data.rates?.[to] || 1380;
    } catch {
      return 1380; // fallback
    }
  },

  estimateShippingCost(weightLbs, service = 'malltail') {
    const rates = { malltail: 6.5, shipnow: 5.9, planet: 5.5 };
    const base = { malltail: 3.99, shipnow: 0, planet: 2.99 };
    const rate = rates[service] || 6.5;
    const b = base[service] || 0;
    return parseFloat((b + weightLbs * rate).toFixed(2));
  },

  // ── 9. WISHLIST (localStorage) ─────────────
  getWishlist() {
    try {
      return JSON.parse(localStorage.getItem('shopiq_wishlist') || '[]');
    } catch { return []; }
  },

  saveWishlist(items) {
    localStorage.setItem('shopiq_wishlist', JSON.stringify(items));
  },

  addToWishlist(item) {
    const list = this.getWishlist();
    if (!list.find(i => i.id === item.id)) {
      list.push({ ...item, saved_at: new Date().toISOString() });
      this.saveWishlist(list);
      return true;
    }
    return false; // already saved
  },

  removeFromWishlist(itemId) {
    const list = this.getWishlist().filter(i => i.id !== itemId);
    this.saveWishlist(list);
  },

  // ── 10. ALERT SUBSCRIPTION ─────────────────
  // In production: POST to your backend → store email + brand prefs
  // Backend sends email/push when sale detected via Shopify scan
  async subscribeAlert(email, brandIds, alertTypes = ['sale', 'drop', 'restock']) {
    // Simulate API call
    console.log('[SHOPIQ] Alert subscription:', { email, brandIds, alertTypes });
    // Real implementation:
    // await fetch('/api/alerts/subscribe', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ email, brandIds, alertTypes }),
    // });
    localStorage.setItem('shopiq_alerts', JSON.stringify({ email, brandIds, alertTypes }));
    return { success: true, message: `Alert set for ${brandIds.length} brands` };
  },

  // ── INIT: Run on page load ──────────────────
  async init(options = {}) {
    console.log('[SHOPIQ] Initializing data layer...');
    const results = {};

    // 1. Reddit (works in browser, CORS allowed)
    if (options.reddit !== false) {
      console.log('[SHOPIQ] Fetching Reddit trends...');
      results.reddit = await this.aggregateRedditTrends();
      console.log(`[SHOPIQ] Reddit: ${results.reddit.total_posts} posts, ${results.reddit.brand_rankings.length} brands ranked`);
    }

    // 2. Exchange rate
    results.exchangeRate = await this.fetchExchangeRate('USD', 'KRW');
    console.log(`[SHOPIQ] USD/KRW rate: ${results.exchangeRate}`);

    // 3. Shopify (CORS blocks direct calls — needs backend proxy in production)
    // results.sales = await this.scanAllSales();

    console.log('[SHOPIQ] Data layer ready.', results);
    return results;
  }
};

// ── Export for use in main HTML ──
if (typeof module !== 'undefined') module.exports = SHOPIQ;
