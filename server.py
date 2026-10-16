#!/usr/bin/env python3
"""
ML-HEP Journal Club Web Server
Clean, zero-dependency HTTP server with SQLite persistence.
Supports paper proposals (arXiv, OpenReview, Nature, PDFs, etc.),
voting with named voters or 1-click votes, and meeting coordination.
"""

import sys
import os
import json
import hmac
import hashlib
import sqlite3
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get("PORT", 8080))
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "journal_club.db")
SEED_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)) , "seed_data.json")
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

MAX_PAYLOAD_BYTES = 32 * 1024  # 32 KB max JSON payload
ALLOWED_STATIC_FILES = {
    "/",
    "/index.html",
    "/styles.css",
    "/app.js",
    "/eth_logo.svg",
    "/seed_data.json",
}
BLOCKED_EXTENSIONS = (".py", ".pyc", ".db", ".sqlite", ".sqlite3", ".sh", ".env", ".log", ".md")

# Salted SHA-256 hashes for Admin PIN and Zoom Kenncode verification
ADMIN_PIN_SALT = "ml_hep_ethz_pin_v1:"
ADMIN_PIN_SHA256 = "5ab6a739d0cbce23127c455134a6482984f0e9169b9b5716f0b0d4feea62511b"

ZOOM_KC_SALT = "ml_hep_ethz_zoom_v1:"
ZOOM_KC_SHA256 = "2ec24bcc093ff2df490a2108b502d19d9f4c3686260588fa134132c351c2b716"
ENCRYPTED_ZOOM_URL = [
    90, 68, 69, 68, 70, 8, 29, 31, 67, 67, 65, 90, 28, 74, 94, 91, 88, 31, 74,
    30, 85, 81, 26, 88, 29, 6, 9, 6, 2, 4, 3, 6, 2, 12, 7, 10, 13, 64, 70, 80,
    8, 80, 67, 3, 101, 82, 3, 118, 4, 114, 102, 124, 67, 3, 125, 113, 127, 82,
    113, 97, 127, 100, 88, 82, 0, 64, 72, 88, 2, 85, 108, 28, 3
]

DEFAULT_INFO = {
    "title": "ML for Particle Physics Journal Club",
    "meeting_day": "Thursday",
    "meeting_time": "14:00",
    "timezone": "Europe/Zurich",
    "room": "HPK D 32",
    "room_building": "ETH Hönggerberg • Physics Building HPK, Floor D"
}

def verify_admin_pin(pin_value):
    if not pin_value:
        return False
    env_pin = os.environ.get("ADMIN_PIN")
    if env_pin:
        return hmac.compare_digest(str(pin_value).strip(), env_pin.strip())
    digest = hashlib.sha256((ADMIN_PIN_SALT + str(pin_value).strip()).encode("utf-8")).hexdigest()
    return hmac.compare_digest(digest, ADMIN_PIN_SHA256)

def verify_zoom_kenncode(code_value):
    if not code_value:
        return None
    clean_code = str(code_value).strip()
    digest = hashlib.sha256((ZOOM_KC_SALT + clean_code).encode("utf-8")).hexdigest()
    if not hmac.compare_digest(digest, ZOOM_KC_SHA256):
        return None
    key = (clean_code * 20).encode("utf-8")
    return bytes([b ^ key[i] for i, b in enumerate(ENCRYPTED_ZOOM_URL)]).decode("utf-8")

def is_safe_http_url(url_str):
    if not url_str or len(url_str) > 2000:
        return False
    try:
        parsed = urllib.parse.urlparse(url_str.strip())
        return parsed.scheme in ("http", "https") and bool(parsed.netloc)
    except Exception:
        return False

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS club_info (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS papers (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                authors TEXT DEFAULT '',
                year INTEGER DEFAULT 2024,
                url TEXT NOT NULL,
                pdf_url TEXT DEFAULT '',
                arxiv_id TEXT DEFAULT '',
                tags TEXT DEFAULT '[]',
                status TEXT DEFAULT 'voting',
                discussed_date TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS votes (
                paper_id TEXT NOT NULL,
                voter_id TEXT NOT NULL,
                voter_name TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                PRIMARY KEY (paper_id, voter_id),
                FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
            )
        """)

        # Default info (ensure sensitive zoom tokens are not stored in public info table)
        conn.execute("DELETE FROM club_info WHERE key IN ('zoom_url', 'zoom_passcode', 'zoom_meeting_id')")
        for key, val in DEFAULT_INFO.items():
            conn.execute("INSERT OR IGNORE INTO club_info (key, value) VALUES (?, ?)", (key, str(val)))

        # Seed papers from seed_data.json if table is empty
        cur = conn.execute("SELECT COUNT(*) FROM papers")
        if cur.fetchone()[0] == 0 and os.path.exists(SEED_PATH):
            try:
                with open(SEED_PATH, "r", encoding="utf-8") as f:
                    seed_papers = json.load(f)
                    for p in seed_papers:
                        paper_id = p.get("id")
                        conn.execute("""
                            INSERT INTO papers (id, title, authors, year, url, pdf_url, arxiv_id, tags, status, discussed_date, notes, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (
                            paper_id,
                            p.get("title"),
                            p.get("authors", ""),
                            p.get("year", 2024),
                            p.get("url"),
                            p.get("pdf_url", ""),
                            p.get("arxiv_id", ""),
                            json.dumps(p.get("tags", [])),
                            p.get("status", "voting"),
                            p.get("discussed_date", ""),
                            p.get("notes", ""),
                            p.get("created_at", datetime.now(timezone.utc).isoformat())
                        ))

                        # Seed voters
                        voters = p.get("voters", [])
                        if voters:
                            for name in voters:
                                voter_id = f"voter_{name.lower().replace(' ', '_')}"
                                conn.execute("INSERT OR IGNORE INTO votes (paper_id, voter_id, voter_name, created_at) VALUES (?, ?, ?, ?)",
                                             (paper_id, voter_id, name, datetime.now(timezone.utc).isoformat()))
                        else:
                            votes_count = p.get("votes", 0)
                            for i in range(votes_count):
                                conn.execute("INSERT OR IGNORE INTO votes (paper_id, voter_id, voter_name, created_at) VALUES (?, ?, ?, ?)",
                                             (paper_id, f"voter_{i}", f"Attendee {i+1}", datetime.now(timezone.utc).isoformat()))
            except Exception as e:
                print(f"Error seeding database: {e}", file=sys.stderr)
    conn.close()

def fetch_arxiv_meta(arxiv_id):
    """Query official arXiv API for paper metadata."""
    clean_id = arxiv_id.strip()
    if clean_id.startswith("arXiv:"):
        clean_id = clean_id[6:]
    api_url = f"http://export.arxiv.org/api/query?id_list={urllib.parse.quote(clean_id)}&max_results=1"
    try:
        req = urllib.request.Request(api_url, headers={"User-Agent": "ML-HEP-Journal-Club/1.0"})
        with urllib.request.urlopen(req, timeout=5) as response:
            content = response.read()
            root = ET.fromstring(content)
            entry = root.find("{http://www.w3.org/2005/Atom}entry")
            if entry is not None:
                title_elem = entry.find("{http://www.w3.org/2005/Atom}title")
                summary_elem = entry.find("{http://www.w3.org/2005/Atom}summary")
                published_elem = entry.find("{http://www.w3.org/2005/Atom}published")
                authors = [a.find("{http://www.w3.org/2005/Atom}name").text
                           for a in entry.findall("{http://www.w3.org/2005/Atom}author")]

                title = title_elem.text.strip().replace("\n", " ") if title_elem is not None else ""
                summary = summary_elem.text.strip().replace("\n", " ") if summary_elem is not None else ""
                year = int(published_elem.text[:4]) if published_elem is not None else datetime.now().year

                return {
                    "success": True,
                    "title": title,
                    "authors": ", ".join(authors),
                    "summary": summary,
                    "year": year,
                    "arxiv_id": clean_id,
                    "url": f"https://arxiv.org/abs/{clean_id}",
                    "pdf_url": f"https://arxiv.org/pdf/{clean_id}.pdf"
                }
    except Exception as e:
        return {"success": False, "error": str(e)}
    return {"success": False, "error": "Not found"}

class JournalClubHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Voter-ID, X-Voter-Name, X-Admin-PIN")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > MAX_PAYLOAD_BYTES:
                return None
            if content_length > 0:
                raw = self.rfile.read(content_length).decode("utf-8")
                return json.loads(raw)
        except Exception:
            pass
        return {}

    def _get_admin_pin(self, data=None):
        pin = self.headers.get("X-Admin-PIN", "").strip()
        if not pin and isinstance(data, dict) and data.get("pin"):
            pin = str(data.get("pin")).strip()
        return pin

    def _is_blocked_static_path(self, raw_path):
        clean_path = urllib.parse.unquote(raw_path).split("?")[0].split("#")[0]
        normalized = os.path.normpath(clean_path)
        if not normalized.startswith("/"):
            normalized = "/" + normalized
        # Block any hidden files/directories (.git, .env, etc.) or parent traversal
        parts = [p for p in normalized.split("/") if p]
        if any(p.startswith(".") or p == ".." for p in parts):
            return True
        if normalized.lower().endswith(BLOCKED_EXTENSIONS):
            return True
        if normalized not in ALLOWED_STATIC_FILES:
            return True
        return False

    def _get_voter_info(self):
        voter_id = self.headers.get("X-Voter-ID")
        voter_name = self.headers.get("X-Voter-Name", "").strip()[:100]
        if not voter_id:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            if "voter_id" in qs:
                voter_id = qs["voter_id"][0]
        if not voter_id:
            voter_id = self.client_address[0]
        return str(voter_id)[:100], voter_name

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/") and self._is_blocked_static_path(parsed.path):
            self._send_json({"error": "Forbidden"}, 403)
            return
        super().do_HEAD()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/info":
            conn = get_db()
            rows = conn.execute("SELECT key, value FROM club_info").fetchall()
            info = {r["key"]: r["value"] for r in rows}
            conn.close()
            self._send_json(info)
            return

        elif path == "/api/papers":
            voter_id, voter_name = self._get_voter_info()
            conn = get_db()
            # Preserve the simple list order (natural order / created_at order)
            sql = """
                SELECT p.*,
                       COUNT(v.voter_id) as votes,
                       MAX(CASE WHEN v.voter_id = ? OR (? != '' AND LOWER(v.voter_name) = LOWER(?)) THEN 1 ELSE 0 END) as user_has_voted,
                       GROUP_CONCAT(v.voter_name, ', ') as voters_str
                FROM papers p
                LEFT JOIN votes v ON p.id = v.paper_id
                GROUP BY p.id
                ORDER BY p.rowid ASC
            """
            rows = conn.execute(sql, (voter_id, voter_name, voter_name)).fetchall()
            papers = []
            for r in rows:
                p = dict(r)
                p["tags"] = json.loads(p["tags"]) if p["tags"] else []
                p["user_has_voted"] = bool(p["user_has_voted"])
                # Extract voter names
                if p.get("voters_str"):
                    p["voters"] = [n.strip() for n in p["voters_str"].split(",") if n.strip()]
                else:
                    p["voters"] = []
                papers.append(p)
            conn.close()
            self._send_json({"papers": papers})
            return

        elif path == "/api/arxiv":
            arxiv_id = qs.get("id", [""])[0]
            if not arxiv_id:
                self._send_json({"error": "Missing arXiv id"}, 400)
                return
            meta = fetch_arxiv_meta(arxiv_id)
            self._send_json(meta)
            return

        elif path == "/api/export":
            conn = get_db()
            papers_rows = conn.execute("SELECT * FROM papers").fetchall()
            papers = [dict(r) for r in papers_rows]
            votes_rows = conn.execute("SELECT * FROM votes").fetchall()
            votes = [dict(r) for r in votes_rows]
            conn.close()
            self._send_json({
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "papers": papers,
                "votes": votes
            })
            return

        if self._is_blocked_static_path(path):
            self._send_json({"error": "Forbidden: Direct access to this file is blocked"}, 403)
            return

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        data = self._read_json()
        if data is None:
            self._send_json({"error": "Payload too large (max 32 KB)"}, 413)
            return

        if path == "/api/zoom":
            kenncode = (data.get("kenncode") or "").strip()
            zoom_url = verify_zoom_kenncode(kenncode)
            if not zoom_url:
                self._send_json({"error": "Incorrect Zoom Kenncode"}, 403)
                return
            self._send_json({"success": True, "zoom_url": zoom_url})
            return

        elif path == "/api/papers":
            title = (data.get("title") or "").strip()[:500]
            url = (data.get("url") or "").strip()[:2000]
            voter_id, voter_name = self._get_voter_info()
            if not voter_name and data.get("voter_name"):
                voter_name = str(data.get("voter_name")).strip()[:100]

            if not title or not url:
                self._send_json({"error": "Title and URL are required"}, 400)
                return
            if not voter_name:
                self._send_json({"error": "Your name is required when adding a paper"}, 400)
                return
            if not is_safe_http_url(url):
                self._send_json({"error": "Paper URL must be a valid http:// or https:// link"}, 400)
                return

            paper_id = (data.get("id") or f"paper-{int(datetime.now(timezone.utc).timestamp()*1000)}")[:100]
            authors = (data.get("authors") or "").strip()[:1000]
            year = int(data.get("year", datetime.now().year))
            pdf_url = (data.get("pdf_url") or "").strip()[:2000]
            if pdf_url and not is_safe_http_url(pdf_url):
                pdf_url = ""
            arxiv_id = (data.get("arxiv_id") or "").strip()[:100]
            tags = data.get("tags") or []
            notes = (data.get("notes") or "").strip()[:1000]
            status = data.get("status", "voting")
            if status not in ("voting", "discussed"):
                status = "voting"
            created_at = datetime.now(timezone.utc).isoformat()

            conn = get_db()
            try:
                with conn:
                    conn.execute("""
                        INSERT INTO papers (id, title, authors, year, url, pdf_url, arxiv_id, tags, status, notes, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (paper_id, title, authors, year, url, pdf_url, arxiv_id, json.dumps(tags), status, notes, created_at))

                    # Proposer gets 1 initial vote tied to their name & voter_id
                    conn.execute("INSERT OR IGNORE INTO votes (paper_id, voter_id, voter_name, created_at) VALUES (?, ?, ?, ?)",
                                 (paper_id, voter_id, voter_name, created_at))
            except sqlite3.IntegrityError:
                conn.close()
                self._send_json({"error": "Paper already exists"}, 409)
                return
            conn.close()
            self._send_json({"success": True, "id": paper_id}, 201)
            return

        elif path.startswith("/api/papers/") and path.endswith("/vote"):
            parts = path.split("/")
            paper_id = parts[3]
            voter_id, voter_name = self._get_voter_info()

            # Parse payload if name provided
            if not voter_name and data.get("name"):
                voter_name = str(data.get("name")).strip()[:100]

            conn = get_db()
            with conn:
                existing = conn.execute(
                    "SELECT 1 FROM votes WHERE paper_id = ? AND (voter_id = ? OR (? != '' AND LOWER(voter_name) = LOWER(?)))",
                    (paper_id, voter_id, voter_name, voter_name)
                ).fetchone()
                if existing:
                    conn.execute(
                        "DELETE FROM votes WHERE paper_id = ? AND (voter_id = ? OR (? != '' AND LOWER(voter_name) = LOWER(?)))",
                        (paper_id, voter_id, voter_name, voter_name)
                    )
                    has_voted = False
                else:
                    if not voter_name:
                        conn.close()
                        self._send_json({"error": "Your name is required to vote"}, 400)
                        return
                    conn.execute("INSERT INTO votes (paper_id, voter_id, voter_name, created_at) VALUES (?, ?, ?, ?)",
                                 (paper_id, voter_id, voter_name, datetime.now(timezone.utc).isoformat()))
                    has_voted = True

                cur = conn.execute("SELECT COUNT(*), GROUP_CONCAT(voter_name, ', ') FROM votes WHERE paper_id = ?", (paper_id,))
                res = cur.fetchone()
                total_votes = res[0]
                voters_str = res[1] or ""
                voters = [v.strip() for v in voters_str.split(",") if v.strip()]

            conn.close()
            self._send_json({
                "success": True,
                "paper_id": paper_id,
                "has_voted": has_voted,
                "votes": total_votes,
                "voters": voters
            })
            return

        self._send_json({"error": "Endpoint not found"}, 404)

    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        data = self._read_json()
        if data is None:
            self._send_json({"error": "Payload too large (max 32 KB)"}, 413)
            return

        if path.startswith("/api/papers/") and path.endswith("/status"):
            pin = self._get_admin_pin(data)
            if not verify_admin_pin(pin):
                self._send_json({"error": "Invalid Admin PIN"}, 403)
                return

            parts = path.split("/")
            paper_id = parts[3]
            status = data.get("status")
            discussed_date = (data.get("discussed_date") or "").strip()[:50]

            valid_statuses = ("voting", "discussed")
            if status not in valid_statuses:
                self._send_json({"error": f"Invalid status. Must be one of {valid_statuses}"}, 400)
                return

            conn = get_db()
            with conn:
                conn.execute("""
                    UPDATE papers
                    SET status = ?, discussed_date = ?
                    WHERE id = ?
                """, (status, discussed_date, paper_id))
            conn.close()
            self._send_json({"success": True, "paper_id": paper_id, "status": status})
            return

        self._send_json({"error": "Endpoint not found"}, 404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        data = self._read_json()
        if data is None:
            self._send_json({"error": "Payload too large (max 32 KB)"}, 413)
            return

        if path.startswith("/api/papers/"):
            pin = self._get_admin_pin(data)
            if not verify_admin_pin(pin):
                self._send_json({"error": "Invalid Admin PIN"}, 403)
                return

            parts = path.split("/")
            paper_id = parts[3]
            conn = get_db()
            with conn:
                conn.execute("DELETE FROM papers WHERE id = ?", (paper_id,))
                conn.execute("DELETE FROM votes WHERE paper_id = ?", (paper_id,))
            conn.close()
            self._send_json({"success": True, "deleted": paper_id})
            return
        self._send_json({"error": "Endpoint not found"}, 404)


def run():
    init_db()
    server_address = ("0.0.0.0", PORT)
    httpd = HTTPServer(server_address, JournalClubHandler)
    print(f"\n=======================================================")
    print(f" ML-HEP Journal Club Server is running!")
    print(f" -> URL: http://localhost:{PORT}")
    print(f" -> Meeting: Every Thursday at 2pm (HPK D 32 + Zoom)")
    print(f"=======================================================\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server gracefully...")
        httpd.server_close()

if __name__ == "__main__":
    run()
