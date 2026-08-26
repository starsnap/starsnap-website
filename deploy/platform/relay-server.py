#!/usr/bin/env python3

import hmac
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


archive_path = Path(os.environ.get("ARCHIVE_PATH", "/transfer/starsnap-platform.enc"))
token_path = Path(os.environ.get("TOKEN_FILE", "/run/transfer-token"))
listen_port = int(os.environ.get("PORT", "8080"))


class RelayHandler(BaseHTTPRequestHandler):
    server_version = "StarSnapMigrationRelay/1"

    def _authorized(self) -> bool:
        expected = f"Bearer {token_path.read_text(encoding='utf-8').strip()}"
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied, expected)

    def _prepare(self) -> bool:
        if self.path != "/starsnap-platform.enc":
            self.send_error(404)
            return False
        if not self._authorized():
            self.send_response(401)
            self.send_header("WWW-Authenticate", "Bearer")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        if not archive_path.is_file():
            self.send_error(503)
            return False

        size = archive_path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        return True

    def do_HEAD(self) -> None:
        self._prepare()

    def do_GET(self) -> None:
        if not self._prepare():
            return
        with archive_path.open("rb") as archive:
            while chunk := archive.read(1024 * 1024):
                self.wfile.write(chunk)

    def log_message(self, format_string: str, *args: object) -> None:
        safe_path = self.path.split("?", 1)[0]
        print(f"{self.client_address[0]} {self.command} {safe_path}", flush=True)


if __name__ == "__main__":
    if not archive_path.is_file():
        raise SystemExit("archive is missing")
    if not token_path.is_file() or not token_path.read_text(encoding="utf-8").strip():
        raise SystemExit("relay token is missing")
    ThreadingHTTPServer(("0.0.0.0", listen_port), RelayHandler).serve_forever()
