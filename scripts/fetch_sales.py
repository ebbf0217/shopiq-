"""Collect live sale data from brand Shopify stores.

Runs every 6 hours in GitHub Actions. For each store it reads the public
/meta.json (name, currency) and /products.json (up to 250 products), finds
variants whose compare_at_price is above price, and keeps products discounted
20% or more. Output: data/sales.json (latest snapshot) and data/history.json
(one summary row per brand per run, for tracking sale activity over time).

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


def scan(domain, cat):
    meta = get_json(f"https://{domain}/meta.json") or {}
    data = get_json(f"https://{domain}/products.json?limit=250")
    products = data.get("products", []) if isinstance(data, dict) else []
    items = []
    for p in products:
        best = None
        for v in p.get("variants", []):
            try:
                price = float(v.get("price") or 0)
                compare = float(v.get("compare_at_price") or 0)
            except ValueError:
                continue
            if price > 0 and compare > price:
                pct = round((1 - price / compare) * 100)
                if best is None or pct > best[0]:
                    best = (pct, price, compare)
        if best and best[0] >= MIN_PCT:
            img = (p.get("images") or [{}])[0].get("src", "")
            if img:
                img += ("&" if "?" in img else "?") + "width=400"
            items.append({
                "title": p.get("title", ""),
                "pct": best[0],
                "price": best[1],
                "compare": best[2],
                "url": f"https://{domain}/products/{p.get('handle', '')}",
                "img": img,
            })
    items.sort(key=lambda x: -x["pct"])
    pcts = sorted(i["pct"] for i in items)
    return {
        "brand": (meta.get("name") or domain.replace("www.", "")).split("|")[0].split(" - ")[0].strip(),
        "domain": domain,
        "cat": cat,
        "currency": meta.get("currency", ""),
        "checked": len(products),
        "on_sale": len(items),
        "max_pct": pcts[-1] if pcts else 0,
        "median_pct": pcts[len(pcts) // 2] if pcts else 0,
        "top": items[:TOP_N],
    }


def main():
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    brands, failed = [], []
    for domain, cat in STORES:
        try:
            b = scan(domain, cat)
            if b["checked"]:
                brands.append(b)
            else:
                failed.append(domain)
        except Exception as e:  # one store failing must not stop the run
            failed.append(domain)
            print(f"skip {domain}: {e}", file=sys.stderr)
        time.sleep(2)
    brands.sort(key=lambda b: (-b["on_sale"], -b["max_pct"]))

    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
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
