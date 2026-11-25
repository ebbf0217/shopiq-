"""Collect sale, new-arrival and price data from brand Shopify stores.

Runs every 3 hours in GitHub Actions (standard library only).

For each store:
  - the full catalog from /products.json (paged, up to MAX_PAGES x 250)
  - the brand's own "new arrivals" collection, in the brand's order

Outputs in data/:
  sales.json        products marked down 20%+ (compare_at_price > price), per store
  arrivals.json     the newest products from each brand's new-arrivals collection
  prices.json       lowest variant price per product, for the next comparison
  price_drops.json  products whose price fell 5%+ since the previous run (kept 7 days)
  history.json      one summary row per store per run
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# domain, filter category, handle of the brand's own new-arrivals collection
STORES = [
    ("www.aloyoga.com", "active", "new-arrivals"),
    ("www.khaite.com", "designer", "new-arrivals"),
    ("www.stinegoya.com", "scandi", "all-new-products"),
    ("www.apc.fr", "french", "new-arrivals-women"),
    ("www.rouje.com", "french", "new-in"),
    ("www.agolde.com", "designer", "womens-new-arrivals"),
    ("www.r13denim.com", "designer", "new-arrivals"),
    ("www.citizensofhumanity.com", "designer", "womens-new-arrivals"),
    ("www.toteme.com", "scandi", "new-in"),
    ("www.staud.clothing", "american", "new-in"),
    ("www.byfar.com", "designer", "new-arrivals"),
    ("madhappy.com", "american", "new-arrivals"),
    ("www.sportyandrich.com", "american", "new-arrivals"),
    ("www.aimeleondore.com", "american", "new-arrivals"),
    ("www.rowingblazers.com", "american", "new-arrivals"),
    ("www.kith.com", "multi", "new-arrivals"),
    ("www.everlane.com", "american", "womens-new-arrivals"),
    ("www.outdoorvoices.com", "active", "m-new-arrivals"),
    ("www.allbirds.com", "american", "womens-new-arrivals"),
    ("www.cuyana.com", "american", "new-arrivals"),
    ("www.loefflerrandall.com", "designer", "new-arrivals"),
    ("www.ullajohnson.com", "designer", "new-arrivals"),
    ("www.loveshackfancy.com", "american", "new-arrivals"),
    ("www.faithfullthebrand.com", "american", "new-arrivals"),
    ("www.hommegirls.com", "american", "new"),
]

MIN_PCT = 20           # sale threshold
TOP_N = 8              # sale items kept per store
MAX_PAGES = 8          # catalog pages per store (250 products each)
NEW_PER_BRAND = 24     # new-arrival items kept per store
DROP_MIN = 0.05        # price drop: 5%+ below the previous run
DROP_KEEP_DAYS = 7
HISTORY_ROWS = 400     # about 100 days at 4 runs a day
UA = "Mozilla/5.0 (compatible; SHOPIQ-sale-monitor/1.1; +https://github.com/ebbf0217/shopiq-)"
DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


# ---------- helpers

def get_json(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < tries - 1:
                time.sleep(10 * (i + 1))
                continue
            raise
    return None


def load(name, default):
    try:
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return default


def save(name, obj, compact=False):
    with open(os.path.join(DATA, name), "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (AttributeError, ValueError):
        return None


def image(p):
    src = (p.get("images") or [{}])[0].get("src", "")
    return src + ("&" if "?" in src else "?") + "width=400" if src else ""


JUNK = re.compile(r"\btest(ing)?\b|gift ?card|e-?gift|do not (buy|purchase)", re.I)


def variant_prices(p):
    """[(price, compare_at_price or 0)] for variants with a price; empty for store test items and gift cards."""
    if JUNK.search(p.get("title", "")) or JUNK.search(p.get("product_type", "")):
        return []
    out = []
    for v in p.get("variants", []):
        try:
            price = float(v.get("price") or 0)
            compare = float(v.get("compare_at_price") or 0)
        except ValueError:
            continue
        if price > 0:
            out.append((price, compare))
    return out


def best_markdown(vps):
    """(pct, price, compare) of the deepest markdown, or None."""
    best = None
    for price, compare in vps:
        if compare > price:
            pct = round((1 - price / compare) * 100)
            if best is None or pct > best[0]:
                best = (pct, price, compare)
    return best


# ---------- per store

def fetch_catalog(domain):
    products = []
    for page in range(1, MAX_PAGES + 1):
        data = get_json(f"https://{domain}/products.json?limit=250&page={page}") or {}
        batch = data.get("products", [])
        products.extend(batch)
        if len(batch) < 250:
            break
        time.sleep(1)
    return products


def scan(domain, cat, new_handle):
    meta = get_json(f"https://{domain}/meta.json") or {}
    brand = (meta.get("name") or domain.replace("www.", "")).split("|")[0].split(" - ")[0].strip()
    currency = meta.get("currency", "")
    products = fetch_catalog(domain)

    sale, prices, info = [], {}, {}
    for p in products:
        handle = p.get("handle", "")
        vps = variant_prices(p)
        if not handle or not vps:
            continue
        prices[handle] = min(v[0] for v in vps)
        info[handle] = p
        md = best_markdown(vps)
        if md and md[0] >= MIN_PCT:
            sale.append({"title": p.get("title", ""), "pct": md[0], "price": md[1], "compare": md[2],
                         "url": f"https://{domain}/products/{handle}", "img": image(p)})
    sale.sort(key=lambda x: -x["pct"])
    pcts = sorted(i["pct"] for i in sale)

    # the brand's own new-arrivals collection, kept in the brand's order
    coll = get_json(f"https://{domain}/collections/{new_handle}/products.json?limit={NEW_PER_BRAND}") or {}
    arrivals = []
    for p in coll.get("products", []):
        vps = variant_prices(p)
        if not vps:
            continue
        md = best_markdown(vps)
        arrivals.append({"title": p.get("title", ""), "price": min(v[0] for v in vps),
                         "compare": md[2] if md else None, "type": p.get("product_type", ""),
                         "url": f"https://{domain}/products/{p.get('handle', '')}", "img": image(p)})

    summary = {
        "brand": brand, "domain": domain, "cat": cat, "currency": currency,
        "checked": len(prices), "on_sale": len(sale),
        "max_pct": pcts[-1] if pcts else 0,
        "median_pct": pcts[len(pcts) // 2] if pcts else 0,
        "top": sale[:TOP_N],
    }
    new_block = {"brand": brand, "domain": domain, "cat": cat, "currency": currency,
                 "collection": f"https://{domain}/collections/{new_handle}", "items": arrivals}
    return summary, new_block, prices, info


# ---------- main

def migrate_prices(old):
    """Older prices.json was {product_url: price}; now it is {domain: {handle: price}}."""
    if not old or all(isinstance(v, dict) for v in old.values()):
        return old
    out = {}
    for url, price in old.items():
        try:
            domain, handle = url.split("://", 1)[1].split("/products/", 1)
        except (IndexError, ValueError):
            continue
        out.setdefault(domain, {})[handle] = price
    return out


def main():
    now_dt = datetime.now(timezone.utc).replace(microsecond=0)
    now = now_dt.isoformat()
    os.makedirs(DATA, exist_ok=True)
    prev_prices = migrate_prices(load("prices.json", {}))
    prev_drop_file = load("price_drops.json", {})

    brands, new_in, failed, prices, drops = [], [], [], {}, []
    for domain, cat, new_handle in STORES:
        try:
            summary, new_block, store_prices, info = scan(domain, cat, new_handle)
        except Exception as e:  # one store failing must not stop the run
            failed.append(domain)
            print(f"skip {domain}: {e}", file=sys.stderr)
            continue
        if not summary["checked"]:
            failed.append(domain)
            continue
        brands.append(summary)
        new_in.append(new_block)
        prices[domain] = store_prices
        old_store = prev_prices.get(domain, {})
        for handle, new in store_prices.items():
            old = old_store.get(handle)
            if old and new <= old * (1 - DROP_MIN):
                p = info[handle]
                drops.append({"title": p.get("title", ""), "brand": summary["brand"],
                              "currency": summary["currency"], "url": f"https://{domain}/products/{handle}",
                              "img": image(p), "old": old, "new": new,
                              "pct": round((1 - new / old) * 100), "detected_at": now})
        time.sleep(2)

    if not brands:
        print("no store answered; keeping previous data", file=sys.stderr)
        sys.exit(1)

    # keep stores that failed this run in the price baseline, so the next run can still compare them
    for domain in failed:
        if domain in prev_prices:
            prices[domain] = prev_prices[domain]

    # price drops: keep the last DROP_KEEP_DAYS days, newest detection wins per product
    merged = {}
    for d in prev_drop_file.get("items", []):
        t = parse_ts(d.get("detected_at"))
        if t and (now_dt - t).days < DROP_KEEP_DAYS:
            merged[d["url"]] = d
    for d in drops:
        merged[d["url"]] = d
    drop_list = sorted(merged.values(), key=lambda d: (d["detected_at"], d["pct"]), reverse=True)[:300]
    runs = prev_drop_file.get("runs_compared", 0) + (1 if prev_prices else 0)
    save("price_drops.json", {
        "fetched_at": now,
        "tracking_since": prev_drop_file.get("tracking_since") or now,
        "runs_compared": runs,
        "products_tracked": sum(len(v) for v in prices.values()),
        "new_this_run": len(drops),
        "items": drop_list,
    })
    save("prices.json", prices, compact=True)

    brands.sort(key=lambda b: (-b["on_sale"], -b["max_pct"]))
    save("sales.json", {"fetched_at": now, "min_pct": MIN_PCT, "brands": brands, "failed": failed})
    save("arrivals.json", {"fetched_at": now, "per_brand": NEW_PER_BRAND, "brands": new_in})

    history = load("history.json", [])
    history.append({"at": now, "brands": {b["brand"]: [b["on_sale"], b["max_pct"]] for b in brands}})
    save("history.json", history[-HISTORY_ROWS:], compact=True)

    print(f"{len(brands)} stores ok, {len(failed)} failed {failed}; "
          f"{sum(len(v) for v in prices.values())} products tracked, {len(drops)} new price drops")


if __name__ == "__main__":
    main()
