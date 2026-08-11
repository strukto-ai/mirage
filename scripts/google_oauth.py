# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
"""Generate a Google OAuth refresh token for Gmail/Drive/Docs/Sheets/Slides.

Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from .env.development, opens
a browser, runs a local-loopback callback, prints the refresh token, and
updates .env.development in place (replacing GOOGLE_REFRESH_TOKEN if
present).

Run from repo root:
    ./python/.venv/bin/python scripts/google_oauth.py
"""
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv
from google_auth_oauthlib.flow import InstalledAppFlow

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env.development"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/forms.body",
    "https://www.googleapis.com/auth/forms.responses.readonly",
]


def main() -> None:
    load_dotenv(ENV_PATH)
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        sys.exit("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing in "
                 ".env.development")

    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }

    flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
    creds = flow.run_local_server(
        host="localhost",
        port=0,
        access_type="offline",
        prompt="consent",
        open_browser=True,
    )

    if not creds.refresh_token:
        sys.exit("No refresh_token returned. Re-run with prompt=consent "
                 "in OAuth screen.")

    print()
    print("=" * 60)
    print("Refresh token (also written to .env.development):")
    print(creds.refresh_token)
    print("=" * 60)

    contents = ENV_PATH.read_text()
    new_line = f"GOOGLE_REFRESH_TOKEN={creds.refresh_token}"
    if re.search(r"^GOOGLE_REFRESH_TOKEN=.*$", contents, re.MULTILINE):
        contents = re.sub(r"^GOOGLE_REFRESH_TOKEN=.*$",
                          new_line,
                          contents,
                          flags=re.MULTILINE)
    else:
        if not contents.endswith("\n"):
            contents += "\n"
        contents += new_line + "\n"
    ENV_PATH.write_text(contents)
    print(f"Updated {ENV_PATH}")


if __name__ == "__main__":
    main()
