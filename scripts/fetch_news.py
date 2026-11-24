"""Collect recent fashion and retail news from public RSS feeds.

Runs with fetch_sales.py in GitHub Actions. Each article keeps only its
headline, source, date and link (no article text or images), plus tags:
brands SHOPIQ follows that the headline mentions, and a topic
(sale/retail, collab/launch). Output: data/news.json.
"""
import email.utils
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

FEEDS = [
    ("WWD", "https://wwd.com/feed/"),
    ("Business of Fashion", "https://www.businessoffashion.com/arc/outboundfeeds/rss/"),
    ("Vogue", "https://www.vogue.com/feed/rss"),
    ("Fashionista", "https://fashionista.com/.rss/full/"),
    ("Hypebeast", "https://hypebeast.com/feed"),
    ("Highsnobiety", "https://www.highsnobiety.com/feed/"),
    ("Glossy", "https://www.glossy.co/feed/"),
    ("Modern Retail", "https://www.modernretail.co/feed/"),
    ("Retail Dive", "https://www.retaildive.com/feeds/news/"),
    ("Footwear News", "https://footwearnews.com/feed/"),
]

BRANDS = [
    "A.P.C.", "Acne Studios", "Agolde", "Aimé Leon Dore", "Alo Yoga", "Arket", "Bottega Veneta",
    "By Far", "Calvin Klein", "Carhartt", "COS", "Citizens of Humanity", "Converse", "Dior",
    "Ganni", "Isabel Marant", "Jacquemus", "Khaite", "Kith", "Lemaire", "Loewe", "Lululemon",
    "Madewell", "Madhappy", "Maison Kitsuné", "Maison Margiela", "Miu Miu", "Nanushka", "New Balance",
    "Nike", "On Running", "Prada", "R13", "Reformation", "Rouje", "Rowing Blazers", "Sacai",
    "Saint Laurent", "Sandro", "Sézane", "SKIMS", "Sporty & Rich", "SSENSE", "Staud", "Stine Goya",
    "Supreme", "The Row", "Toteme", "Uniqlo", "Zara", "Mytheresa", "Net-a-Porter", "Farfetch",
    "Shopbop", "Gentle Monster", "Musinsa", "Louis Vuitton", "Gucci", "Chanel", "Hermès",
    "Balenciaga", "Comme des Garçons", "Coach", "Ralph Lauren", "Abercrombie", "Adidas", "H&M",
    "Mango", "Aritzia", "Marimekko", "Burberry", "Celine", "Valentino", "Ami Paris", "Patagonia",
]
TOPICS = {
    "sale": r"\b(sale|discount|markdown|promotion|black friday|cyber monday|price|tariff|resale|outlet)\b",
    "collab": r"\b(collab\w*|capsule|drop|launch\w*|partner\w*|x\s)\b",
    "business": r"\b(revenue|sales growth|earnings|acquisition|acquire\w*|ipo|funding|profit|quarter|ceo|layoff\w*|stake)\b",
    "korea": r"\b(k-pop|korea\w*|seoul)\b",
}
UA = "Mozilla/5.0 (compatible; SHOPIQ-news/1.0; +https://github.com/ebbf0217/shopiq-)"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEEP = 120


def norm(s):
    return re.sub(r"[^a-z0-9& ]", "", s.lower().replace("é", "e").replace("è", "e"))


BRAND_RE = [(b, re.compile(r"(?<![a-z0-9])" + re.escape(norm(b)) + r"(?![a-z0-9])")) for b in BRANDS]


def parse_date(s):
    try:
        return email.utils.parsedate_to_datetime(s).astimezone(timezone.utc)
    except Exception:
        return None


def main():
    seen, out, failed = set(), [], []
    for source, url in FEEDS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                root = ET.fromstring(r.read())
        except Exception as e:
            failed.append(source)
            print(f"skip {source}: {e}", file=sys.stderr)
            continue
        for it in root.findall(".//item"):
            title = re.sub(r"\s+", " ", (it.findtext("title") or "")).strip()
            link = (it.findtext("link") or "").strip()
            dt = parse_date(it.findtext("pubDate") or "")
            if not title or not link or not dt or link in seen:
                continue
            seen.add(link)
            t = norm(title)
            brands = [b for b, rx in BRAND_RE if rx.search(t)]
            topics = [k for k, rx in TOPICS.items() if re.search(rx, title.lower())]
            out.append({
                "title": title,
                "source": source,
                "url": link,
                "date": dt.replace(microsecond=0).isoformat(),
                "brands": brands,
                "topics": topics,
            })
    out.sort(key=lambda a: a["date"], reverse=True)
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    with open(os.path.join(ROOT, "data", "news.json"), "w", encoding="utf-8") as f:
        json.dump({"fetched_at": now, "articles": out[:KEEP], "failed": failed}, f, ensure_ascii=False, indent=1)
    print(f"{len(out)} articles from {len(FEEDS) - len(failed)} feeds; failed: {failed}")
    if not out:
        sys.exit(1)


if __name__ == "__main__":
    main()
