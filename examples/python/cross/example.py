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

import asyncio
import json
import os

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.discord import DiscordConfig, DiscordResource
from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource
from mirage.resource.gmail import GmailConfig, GmailResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.resource.slack import SlackConfig, SlackResource

load_dotenv(".env.development")

google_kwargs = dict(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)

s3 = S3Resource(config=S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
))
gdrive = GoogleDriveResource(config=GoogleDriveConfig(**google_kwargs))
gmail = GmailResource(config=GmailConfig(**google_kwargs))
slack = SlackResource(config=SlackConfig(
    token=os.environ["SLACK_BOT_TOKEN"],
    search_token=os.environ.get("SLACK_USER_TOKEN"),
))
discord = DiscordResource(config=DiscordConfig(
    token=os.environ["DISCORD_BOT_TOKEN"]))

# Stable path that both scripts agree on. Override with the env var
# MIRAGE_CROSS_DIR if you want a different location.
SNAPSHOT_DIR = os.environ.get("MIRAGE_CROSS_DIR", "/tmp/mirage-cross-clone")
SNAPSHOT_TAR = os.path.join(SNAPSHOT_DIR, "snapshot.tar")
EXPECTED_JSON = os.path.join(SNAPSHOT_DIR, "expected.json")

# Read-only commands whose output is deterministic between runs.
# The loader script reruns the same commands and asserts identical output.
_FINGERPRINT_COMMANDS = [
    'head -n 1 /s3/data/example.jsonl',
    'cat /s3/data/example.jsonl | wc -l',
    'grep -c "mirage" /s3/data/example.jsonl',
    'head -n 1 "/gdrive/AWS CDK.gdoc.json"',
    'wc -l "/gdrive/AWS CDK.gdoc.json"',
    'cat /s3/data/example.jsonl "/gdrive/AWS CDK.gdoc.json" | wc -l',
]


async def _capture(ws, cmd):
    r = await ws.execute(cmd)
    return {
        "command": cmd,
        "exit_code": r.exit_code,
        "stdout": (await r.stdout_str()).strip(),
        "stderr": (await r.stderr_str()).strip(),
    }


async def main():
    ws = Workspace(
        {
            "/s3": s3,
            "/gdrive": gdrive,
            "/gmail": gmail,
            "/slack": slack,
            "/discord": discord,
        },
        mode=MountMode.WRITE,
    )

    # gdrive needs `ls` of the parent folder first so the index has
    # the file_id mapping the loader will need too.
    await ws.execute("ls /gdrive/")

    # Warm the cache by running each fingerprint command once and
    # discarding the output. This way the snapshot's cache state
    # matches what the loader will see — and downstream commands like
    # `wc -l` produce identical formatting on both sides (some commands
    # format slightly differently between cache-hit and source-read
    # paths; warming makes the comparison apples-to-apples).
    for cmd in _FINGERPRINT_COMMANDS:
        await ws.execute(cmd)

    # ── exercise the workspace (read-only for determinism) ──────────
    print("=== capturing fingerprint commands ===\n")
    fingerprints = []
    for cmd in _FINGERPRINT_COMMANDS:
        cap = await _capture(ws, cmd)
        fingerprints.append(cap)
        head = cap["stdout"][:80].replace("\n", " ")
        print(f"  {cmd}")
        print(f"    exit={cap['exit_code']}  stdout={head!r}")

    # ── snapshot the workspace + expected outputs ──────────────────
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    await ws.snapshot(SNAPSHOT_TAR)
    with open(EXPECTED_JSON, "w") as f:
        json.dump(
            {
                "tar_path": SNAPSHOT_TAR,
                "fingerprints": fingerprints,
            },
            f,
            indent=2,
        )

    print("\n=== saved ===")
    print(f"  tar:      {SNAPSHOT_TAR} "
          f"({os.path.getsize(SNAPSHOT_TAR)} bytes)")
    print(f"  expected: {EXPECTED_JSON}")
    print("\nNow run: ./python/.venv/bin/python "
          "examples/python/cross/load_check.py")


if __name__ == "__main__":
    asyncio.run(main())
