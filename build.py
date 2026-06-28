#!/usr/bin/env python3
"""Reproducible build: inline card art + all JS modules into a single self-contained index.html.

  python build.py

Reads src/*.js + src/nana_src.html + assets/card_data.json and writes index.html.
"""
import json, pathlib, sys

HERE = pathlib.Path(__file__).parent

def src(name): return (HERE / "src" / name).read_text(encoding="utf-8")

def main():
    data = json.loads((HERE / "assets" / "card_data.json").read_text(encoding="utf-8"))
    tpl = src("nana_src.html")
    markers = ("/*__CARD_DATA__*/", "/*__PERSONALITIES_JS__*/", "/*__ENGINE_JS__*/", "/*__QUIP_JS__*/", "/*__UI_JS__*/")
    for m in markers:
        if m not in tpl:
            sys.exit("template missing marker: " + m)
    out = (tpl
           .replace("/*__CARD_DATA__*/", "window.CARD_IMAGES = " + json.dumps(data, ensure_ascii=False) + ";")
           .replace("/*__PERSONALITIES_JS__*/", src("personalities.js"))
           .replace("/*__ENGINE_JS__*/", src("engine.js"))
           .replace("/*__QUIP_JS__*/", src("quip.js"))
           .replace("/*__UI_JS__*/", src("ui.js")))
    (HERE / "index.html").write_text(out, encoding="utf-8")
    print("wrote index.html (%.1f KB)" % (len(out) / 1024))

if __name__ == "__main__":
    main()
