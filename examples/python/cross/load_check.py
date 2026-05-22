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
import sys

from dotenv import load_dotenv

from mirage.resource.discord import DiscordConfig, DiscordResource
from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource
from mirage.resource.gmail import GmailConfig, GmailResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.resource.slack import SlackConfig, SlackResource
from mirage.workspace import Workspace

load_dotenv(".env.development")

EXPECTED_JSON = os.environ.get(
    "MIRAGE_CROSS_EXPECTED",
    "/tmp/mirage-cross-clone/expected.json",
)


def _fresh_resources():
    google_kwargs = dict(
        client_id=os.environ["GOOGLE_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
        refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
    )
    return {
        "/s3":
        S3Resource(config=S3Config(
            bucket=os.environ["AWS_S3_BUCKET"],
            region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
            aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        )),
        "/gdrive":
        GoogleDriveResource(config=GoogleDriveConfig(**google_kwargs)),
        "/gmail":
        GmailResource(config=GmailConfig(**google_kwargs)),
        "/slack":
        SlackResource(config=SlackConfig(
            token=os.environ["SLACK_BOT_TOKEN"],
            search_token=os.environ.get("SLACK_USER_TOKEN"),
        )),
        "/discord":
        DiscordResource(config=DiscordConfig(
            token=os.environ["DISCORD_BOT_TOKEN"])),
    }


async def _capture(ws, cmd):
    r = await ws.execute(cmd)
    return {
        "command": cmd,
        "exit_code": r.exit_code,
        "stdout": (await r.stdout_str()).strip(),
        "stderr": (await r.stderr_str()).strip(),
    }


def _summarize(field, expected, got):
    if expected == got:
        return "OK"
    if isinstance(expected, str) and isinstance(got, str):
        if len(expected) > 60 or len(got) > 60:
            return (f"DIFF (lengths exp={len(expected)} got={len(got)}; "
                    f"first diff at char {_first_diff(expected, got)})")
    return f"DIFF (expected={expected!r}, got={got!r})"


def _first_diff(a, b):
    for i, (ca, cb) in enumerate(zip(a, b)):
        if ca != cb:
            return i
    return min(len(a), len(b))


async def main():
    if not os.path.exists(EXPECTED_JSON):
        print(f"ERROR: {EXPECTED_JSON} not found.")
        print("Run examples/python/cross/example.py first to create "
              "the snapshot.")
        sys.exit(1)

    with open(EXPECTED_JSON) as f:
        expected_doc = json.load(f)

    tar_path = expected_doc["tar_path"]
    print(f"=== loading {tar_path} ===")
    ws = Workspace.load(tar_path, resources=_fresh_resources())
    mounts = sorted(m.prefix for m in ws.mounts())
    print(f"  mounts: {mounts}")
    print(f"  loaded history entries: "
          f"{len(ws.history.entries()) if ws.history else 0}")

    # gdrive index belongs to the freshly-supplied resource (override
    # drops the saved index). Repopulate it the same way the original
    # script did, so the loader's commands resolve the same paths.
    await ws.execute("ls /gdrive/")

    # ── re-execute fingerprint commands and compare ─────────────────
    print(f"\n=== re-running {len(expected_doc['fingerprints'])} commands "
          "and comparing ===\n")

    n_match = 0
    n_diff = 0
    for expected in expected_doc["fingerprints"]:
        got = await _capture(ws, expected["command"])
        all_ok = True
        for field in ("exit_code", "stdout", "stderr"):
            verdict = _summarize(field, expected[field], got[field])
            if verdict != "OK":
                all_ok = False

        marker = "✓" if all_ok else "✗"
        print(f"  {marker} {expected['command']}")
        if not all_ok:
            for field in ("exit_code", "stdout", "stderr"):
                v = _summarize(field, expected[field], got[field])
                if v != "OK":
                    print(f"      {field}: {v}")
        if all_ok:
            n_match += 1
        else:
            n_diff += 1

    print(f"\n=== summary: {n_match} match, {n_diff} differ ===")
    if n_diff > 0:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
