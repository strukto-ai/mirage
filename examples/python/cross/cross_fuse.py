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

import json
import os
import shutil
import tempfile
from pathlib import Path

from dotenv import load_dotenv

from mirage import Workspace
from mirage.resource.disk import DiskResource
from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource
from mirage.resource.gmail import GmailConfig, GmailResource
from mirage.resource.notion import NotionConfig, NotionResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.resource.slack import SlackConfig, SlackResource

load_dotenv(".env.development")

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"

tmp = tempfile.mkdtemp()
shutil.copytree(DATA_DIR, Path(tmp) / "files", dirs_exist_ok=True)

google_kwargs = dict(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)

notion = NotionResource(config=NotionConfig(
    api_key=os.environ["NOTION_API_KEY"]))
gdrive = GoogleDriveResource(config=GoogleDriveConfig(**google_kwargs))
gmail = GmailResource(config=GmailConfig(**google_kwargs))
local = DiskResource(root=tmp + "/files")
s3 = S3Resource(config=S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
))
slack = SlackResource(config=SlackConfig(
    token=os.environ["SLACK_BOT_TOKEN"],
    search_token=os.environ.get("SLACK_USER_TOKEN"),
))

with Workspace({
        "/notion/": notion,
        "/gdrive/": gdrive,
        "/gmail/": gmail,
        "/local/": local,
        "/s3/": s3,
        "/slack/": slack,
}) as ws:
    # One FUSE mount over the workspace root exposes every backend as a
    # subdirectory of a single real filesystem path.
    mp = ws.add_fuse_mount("/")

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() workspace root ---")
    for e in sorted(os.listdir(mp)):
        print(f"  {e}/")

    print("\n--- /notion: os.listdir() pages ---")
    pages = os.listdir(f"{mp}/notion/pages")
    for p in pages[:5]:
        print(f"  {p}")
    if pages:
        with open(f"{mp}/notion/pages/{pages[0]}/page.json") as f:
            data = json.loads(f.read())
        print(f"  first page title: {data.get('title')}")

    print("\n--- /gdrive: os.listdir() root ---")
    drive_entries = os.listdir(f"{mp}/gdrive")
    for e in drive_entries[:5]:
        print(f"  {e}")
    for e in drive_entries:
        path = f"{mp}/gdrive/{e}"
        if os.path.isfile(path):
            with open(path, "rb") as f:
                head = f.read(1024)
            print(f"  read {e}: {len(head)} bytes (first 1024)")
            break

    print("\n--- /gmail: os.listdir() labels ---")
    labels = os.listdir(f"{mp}/gmail")
    for lb in labels[:5]:
        print(f"  {lb}")
    inbox = f"{mp}/gmail/INBOX"
    if os.path.isdir(inbox):
        dates = os.listdir(inbox)
        if dates:
            messages = os.listdir(f"{inbox}/{dates[0]}")
            json_msgs = [m for m in messages if m.endswith(".gmail.json")]
            if json_msgs:
                with open(f"{inbox}/{dates[0]}/{json_msgs[0]}") as f:
                    parsed = json.loads(f.read())
                print(f"  latest INBOX message ({dates[0]}):")
                print(f"    subject: {parsed.get('subject', 'N/A')}")
                print(f"    from: {parsed.get('from', 'N/A')}")

    print("\n--- /local: os.listdir() + sizes ---")
    for e in os.listdir(f"{mp}/local"):
        size = os.path.getsize(f"{mp}/local/{e}")
        print(f"  {e:30s} {size:>10,} bytes")

    print("\n--- /s3: open() + read 3 lines ---")
    with open(f"{mp}/s3/data/example.jsonl") as f:
        for i, line in enumerate(f):
            if i >= 3:
                break
            print(f"  [{i}] {line.strip()[:100]}...")

    print("\n--- /slack: os.listdir() channels ---")
    channels = os.listdir(f"{mp}/slack/channels")
    for ch in channels[:5]:
        print(f"  {ch}")
    if channels:
        ch = next((c for c in channels if "general" in c), channels[0])
        for d in reversed(os.listdir(f"{mp}/slack/channels/{ch}")):
            path = f"{mp}/slack/channels/{ch}/{d}/chat.jsonl"
            if not os.path.exists(path):
                continue
            lines = []
            with open(path) as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
            texted = [
                m for m in map(json.loads, lines) if m.get("text", "").strip()
            ]
            if texted:
                msg = texted[-1]
                print(f"  latest message in {ch} ({d}):")
                print(f"    [{msg.get('user', '?')}] "
                      f"{msg.get('text', '')[:80]}")
                break

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/")
    print(f">>>   ls {mp}/notion/pages/")
    print(f">>>   ls {mp}/gmail/INBOX/")
    print(f">>>   cat {mp}/s3/data/example.jsonl | head -n 3")
    print(f">>>   cat {mp}/local/example.json | jq .")
    print(f">>>   ls {mp}/slack/channels/")
    print(">>> Press Enter to unmount and exit...")
    try:
        input()
    except EOFError:
        pass

    records = ws.fs.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
