#!/usr/bin/env python3
"""
DSH Web redirect service for phone access via Tailscale.

DSH Web (port 3080) listens on loopback only, so remote clients reach it
through the Tailscale serve proxy on the tailnet HTTPS URL (port 443).
This service sits behind that proxy and turns one stable bookmark into a
fresh authenticated URL on every request:

    https://pop-os.taildc49b0.ts.net/      (stable bookmark)
        -> 302 -> https://pop-os.taildc49b0.ts.net/?token=<current>
        -> DSH mints an authority-bound cookie, 303 -> /

The launch token changes on every DSH restart; DSH writes it to
~/.dsh/web-launch-token at startup, and this service reads it per request,
so the bookmark survives restarts without any manual step.

Endpoints:
    /, /dsh    302 to the current authenticated DSH URL
    /dsh-url   the current authenticated URL as plain text
    /health    JSON status

Usage:
    python3 dsh-web-redirect.py [--port 3090]
"""

import http.server
import json
import os
import signal
import socketserver
import subprocess
import sys

DEFAULT_PORT = 3090
TOKEN_FILE = os.path.expanduser("~/.dsh/web-launch-token")
FALLBACK_DNS_NAME = "pop-os.taildc49b0.ts.net"


def resolve_dns_name() -> str:
    """Resolve this node's tailnet DNS name; fall back to the known name."""
    try:
        out = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True, text=True, timeout=10,
        )
        name = json.loads(out.stdout).get("Self", {}).get("DNSName", "")
        return name.rstrip(".") or FALLBACK_DNS_NAME
    except Exception:
        return FALLBACK_DNS_NAME


def get_token() -> str | None:
    """Read the current DSH launch token; None when DSH has not written one."""
    try:
        with open(TOKEN_FILE) as f:
            token = f.read().strip()
        return token or None
    except FileNotFoundError:
        return None


DNS_NAME = resolve_dns_name()


def authenticated_url() -> str | None:
    token = get_token()
    if token is None:
        return None
    return f"https://{DNS_NAME}/?token={token}"


class DSHRedirectHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[dsh-redirect] {self.address_string()} - {fmt % args}\n")

    def do_GET(self):
        url = authenticated_url()
        if self.path in ("/", "/dsh"):
            if url is None:
                self._plain(500, "DSH auth token not found; is DSH running?")
            else:
                self.send_response(302)
                self.send_header("Location", url)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
        elif self.path == "/dsh-url":
            self._plain(200 if url else 500, url or "DSH auth token not found")
        elif self.path == "/health":
            self._json({"status": "ok", "dns": DNS_NAME, "token-present": url is not None})
        else:
            self._plain(404, "not found")

    def _plain(self, code: int, body: str) -> None:
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj: dict) -> None:
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run_server(port: int) -> None:
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", port), DSHRedirectHandler) as httpd:
        print(f"DSH Web redirect service on port {port}")
        print(f"Bookmark this on the phone: https://{DNS_NAME}/")

        def shutdown(signum, frame):
            print("\nShutting down...")
            httpd.server_close()
            sys.exit(0)

        signal.signal(signal.SIGINT, shutdown)
        signal.signal(signal.SIGTERM, shutdown)
        httpd.serve_forever()


if __name__ == "__main__":
    port = DEFAULT_PORT
    if len(sys.argv) > 2 and sys.argv[1] == "--port":
        port = int(sys.argv[2])
    run_server(port)
