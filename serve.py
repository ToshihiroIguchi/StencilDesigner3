#!/usr/bin/env python3
"""Serve the built StencilDesigner3 app (dist/) using only the Python standard library.

Usage:
    python serve.py                 # http://127.0.0.1:8600/, opens the browser
    python serve.py --port 9090 --no-browser

Why not `python -m http.server`? It guesses MIME types from the OS (on Windows,
the registry). A registry that maps .js to text/plain makes browsers reject ES
module scripts and Workers, and a missing .wasm type breaks streaming WebAssembly
compilation (DWG import). This script pins the types the app needs.
"""
import argparse
import os
import sys
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME_TYPES}

    def guess_type(self, path):
        ext = os.path.splitext(str(path))[1].lower()
        return MIME_TYPES.get(ext) or super().guess_type(path)


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Serve the built StencilDesigner3 app.")
    parser.add_argument("--dir", default=os.path.join(here, "dist"), help="directory to serve (default: ./dist)")
    parser.add_argument("--host", default="127.0.0.1", help="address to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8600, help="port to listen on (default: 8600)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    args = parser.parse_args()

    root = os.path.abspath(args.dir)
    if not os.path.isfile(os.path.join(root, "index.html")):
        print(f"Error: {root} does not contain index.html.", file=sys.stderr)
        print(
            "Download stencildesigner3-dist-<version>.zip from the GitHub Releases page "
            "and unzip it next to serve.py,\nor build it with `npm install && npm run build`.",
            file=sys.stderr,
        )
        return 1

    try:
        server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=root))
    except OSError as e:
        print(f"Error: cannot listen on {args.host}:{args.port} ({e}). Try --port <other>.", file=sys.stderr)
        return 1

    url = f"http://{args.host}:{args.port}/"
    print(f"Serving {root}\nOpen {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
