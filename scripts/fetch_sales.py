"""Collect live sale data from brand Shopify stores.

Runs every 6 hours in GitHub Actions. For each store it reads the public
/meta.json (name, currency) and /products.json (up to 250 products), finds
variants whose compare_at_price is above price, and keeps products discounted
20% or more. Outputs in data/:
  sales.json        latest sale snapshot per store
  arrivals.json     products published in the last 14 days (published_at)
  prices.json       lowest variant price per product, compared on the next run
  price_drops.json  products whose price fell 5%+ since the previous run (kept 7 days)
  history.json      one summary row per store per run

Standard library only, so the workflow needs no install step.
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

STORES = [
    # domain, category used by the page's filter buttons
    ("www.aloyoga.com", "active"),
    ("www.khaite.com", "designer"),
    ("www.stinegoya.com", "scandi"),
    ("www.apc.fr", "french"),
    ("www.rouje.com", "french"),
    ("www.agolde.com", "designer"),
    ("www.r13denim.com", "designer"),
    ("www.citizensofhumanity.com", "designer"),
    ("www.toteme.com", "scandi"),
    ("www.staud.clothing", "american"),
    ("www.byfar.com", "designer"),
    ("madhappy.com", "american"),
    ("www.sportyandrich.com", "american"),
    ("www.aimeleondore.com", "american"),
    ("www.rowingblazers.com", "american"),
    ("www.kith.com", "multi"),
    ("www.everlane.com", "american"),
    ("www.outdoorvoices.com", "active"),
    ("www.allbirds.com", "american"),
    ("www.cuyana.com", "american"),
    ("www.loefflerrandall.com", "designer"),
    ("www.ullajohnson.com", "designer"),
    ("www.loveshackfancy.com", "american"),
    ("www.faithfullthebrand.com", "american"),
    ("www.hommegirls.com", "american"),
]

MIN_PCT = 20
TOP_N = 8
ARRIVAL_DAYS = 14      # "new in" window, from each product's published_at
DROP_MIN = 0.05        # a price drop is at least 5% below the previous collection
DROP_KEEP_DAYS = 7
UA = "Mozilla/5.0 (compatible; SHOPIQ-sale-monitor/1.0; +https://github.com/ebbf0217/shopiq-)"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_json(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < tries - 1:
                time.sleep(10 * (i + 1))
                continue
            raise
    return None


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def first_img(p):
    img = (p.get("images") or [{}])[0].get("src", "")
    if img:
        img += ("&" if "?" in img else "?") + "width=400"
    return img


def scan(domain, cat, now):
    """Returns (brand summary, new arrivals, {product url: lowest variant price})."""
    meta = get_json(f"https://{domain}/meta.json") or {}
    data = get_json(f"https://{domain}/products.json?limit=250")
    products = data.get("products", []) if isinstance(data, dict) else []
    brand = (meta.get("name") or domain.replace("www.", "")).split("|")[0].split(" - ")[0].strip()
    currency = meta.get("currency", "")
    items, arrivals, prices = [], [], {}
    for p in products:
        url = f"https://{domain}/products/{p.get('handle', '')}"
        vprices = []
        best = None
        for v in p.get("variants", []):
            try:
                price = float(v.get("price") or 0)
                compare = float(v.get("compare_at_price") or 0)
            except ValueError:
                continue
            if price > 0:
                vprices.append(price)
            if price > 0 and compare > price:
                pct = round((1 - price / compare) * 100)
                if best is None or pct > best[0]:
                    best = (pct, price, compare)
        if vprices:
            prices[url] = min(vprices)
        pub = parse_ts(p.get("published_at") or "")
        if pub and (now - pub).days < ARRIVAL_DAYS and vprices:
            arrivals.append({
                "title": p.get("title", ""), "brand": brand, "cat": cat, "currency": currency,
                "price": min(vprices), "url": url, "img": first_img(p),
                "published_at": pub.replace(microsecond=0).isoformat(),
                "type": p.get("product_type", ""),
            })
        if best and best[0] >= MIN_PCT:
            img = first_img(p)
            items.append({
                "title": p.get("title", ""),
                "pct": best[0],
                "price": best[1],
                "compare": best[2],
                "url": url,
                "img": img,
            })
    items.sort(key=lambda x: -x["pct"])
    pcts = sorted(i["pct"] for i in items)
    summary = {
        "brand": brand,
        "domain": domain,
        "cat": cat,
        "currency": currency,
        "checked": len(products),
        "on_sale": len(items),
        "max_pct": pcts[-1] if pcts else 0,
        "median_pct": pcts[len(pcts) // 2] if pcts else 0,
        "new_14d": len(arrivals),
        "top": items[:TOP_N],
    }
    return summary, arrivals, prices, None, products


def load(name, default):
    try:
        with open(os.path.join(ROOT, "data", name), encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return default


def save(name, obj, compact=False):
    with open(os.path.join(ROOT, "data", name), "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)


def main():
    now_dt = datetime.now(timezone.utc).replace(microsecond=0)
    now = now_dt.isoformat()
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    prev_prices = load("prices.json", {})
    prev_drops = load("price_drops.json", {"items": []}).get("items", [])

    brands, failed, arrivals, prices, drops = [], [], [], {}, []
    for domain, cat in STORES:
        try:
            b, arr, pr, _, products = scan(domain, cat, now_dt)
            if not b["checked"]:
                failed.append(domain)
                continue
            brands.append(b)
            arrivals.extend(arr)
            prices.update(pr)
            # price drops: same product, lower price than the previous collection
            for p in products:
                url = f"https://{domain}/products/{p.get('handle', '')}"
                old, new = prev_prices.get(url), pr.get(url)
                if old and new and new <= old * (1 - DROP_MIN):
                    drops.append({
                        "title": p.get("title", ""), "brand": b["brand"], "currency": b["currency"],
                        "url": url, "img": first_img(p), "old": old, "new": new,
                        "pct": round((1 - new / old) * 100), "detected_at": now,
                    })
        except Exception as e:  # one store failing must not stop the run
            failed.append(domain)
            print(f"skip {domain}: {e}", file=sys.stderr)
        time.sleep(2)
    brands.sort(key=lambda b: (-b["on_sale"], -b["max_pct"]))

    # keep drops from the last DROP_KEEP_DAYS days; newest detection wins per product
    merged = {d["url"]: d for d in prev_drops
              if parse_ts(d["detected_at"]) and (now_dt - parse_ts(d["detected_at"])).days < DROP_KEEP_DAYS}
    for d in drops:
        merged[d["url"]] = d
    drop_list = sorted(merged.values(), key=lambda d: (d["detected_at"], d["pct"]), reverse=True)[:300]
    tracking_since = load("price_drops.json", {}).get("tracking_since") or now
    save("price_drops.json", {"fetched_at": now, "tracking_since": tracking_since,
                              "compared_with_previous": bool(prev_prices), "items": drop_list})
    save("prices.json", prices, compact=True)

    arrivals.sort(key=lambda a: a["published_at"], reverse=True)
    save("arrivals.json", {"fetched_at": now, "days": ARRIVAL_DAYS, "items": arrivals[:400]})

    snapshot = {"fetched_at": now, "min_pct": MIN_PCT, "brands": brands, "failed": failed}
    with open(os.path.join(ROOT, "data", "sales.json"), "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=1)

    hist_path = os.path.join(ROOT, "data", "history.json")
    try:
        with open(hist_path, encoding="utf-8") as f:
            history = json.load(f)
    except (FileNotFoundError, ValueError):
        history = []
    history.append({
        "at": now,
        "brands": {b["brand"]: [b["on_sale"], b["max_pct"]] for b in brands},
    })
    history = history[-400:]  # about 100 days at 4 runs a day
    with open(os.path.join(ROOT, "data", "history.json"), "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, separators=(",", ":"))

    print(f"{len(brands)} stores ok, {len(failed)} failed: {failed}")
    if not brands:
        sys.exit(1)


if __name__ == "__main__":
    main()
