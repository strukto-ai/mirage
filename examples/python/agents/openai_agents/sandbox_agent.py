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
import os

from agents import Runner
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.agents.openai_agents import MirageSandboxClient
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.vfs.slack import SlackConfig, SlackVFS

load_dotenv(".env.development")

ram = RAMVFS()
s3 = S3VFS(
    S3Config(
        bucket=os.environ["AWS_S3_BUCKET"],
        region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    ))
slack = SlackVFS(config=SlackConfig(
    token=os.environ["SLACK_BOT_TOKEN"],
    search_token=os.environ.get("SLACK_USER_TOKEN"),
))

ws = Workspace(
    {
        "/": (ram, MountMode.WRITE),
        "/s3": (s3, MountMode.READ),
        "/slack": (slack, MountMode.READ),
    },
    mode=MountMode.WRITE,
)

client = MirageSandboxClient(ws)

agent = SandboxAgent(
    name="Mirage Sandbox Agent",
    model="gpt-5.5",
    instructions=ws.file_prompt,
)

task = ("1. Find the date of the latest Slack message in the general channel. "
        "2. Summarize the parquet file in /s3/data/. "
        "Write your findings to /report.txt.")


async def main():
    result = await Runner.run(
        agent,
        task,
        run_config=RunConfig(sandbox=SandboxRunConfig(client=client)),
    )
    print(result.final_output)

    ws = client._ws
    find_all = await ws.shell("find / -type f")
    print("\n--- Files in workspace ---")
    print((find_all.stdout or b"").decode())

    # ── persist/hydrate via the OpenAI Agents sandbox API ──────────
    # MirageSandboxSession.persist_workspace returns a BytesIO with a
    # tar; hydrate_workspace mutates an existing session's workspace
    # in place. Build a fresh session (with the same mount shape) and
    # restore the snapshot into it.
    print("\n--- persist / hydrate via sandbox API ---")
    session = await client.create()
    snapshot = await session.persist_workspace()
    snapshot_size = snapshot.getbuffer().nbytes
    print(f"  persisted snapshot: {snapshot_size:,} bytes")

    # Fresh client with the same mount shape — required so hydrate
    # finds the same prefixes to restore content into.
    fresh_ws = Workspace(
        {
            "/": (RAMVFS(), MountMode.WRITE),
            "/s3": (S3VFS(
                S3Config(
                    bucket=os.environ["AWS_S3_BUCKET"],
                    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
                    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
                    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
                )), MountMode.READ),
            "/slack": (SlackVFS(config=SlackConfig(
                token=os.environ["SLACK_BOT_TOKEN"],
                search_token=os.environ.get("SLACK_USER_TOKEN"),
            )), MountMode.READ),
        },
        mode=MountMode.WRITE,
    )
    fresh_client = MirageSandboxClient(fresh_ws)
    fresh_session = await fresh_client.create()
    await fresh_session.hydrate_workspace(snapshot)

    fresh_find = await fresh_ws.shell("find / -type f")
    print("--- Files in hydrated workspace ---")
    print((fresh_find.stdout or b"").decode())

    orig_files = set((find_all.stdout or b"").decode().strip().splitlines())
    fresh_files = set((fresh_find.stdout or b"").decode().strip().splitlines())
    diff = orig_files.symmetric_difference(fresh_files)
    print(f"--- file list diff: {len(diff)} files differ "
          f"{'(OK)' if not diff else '(' + str(diff) + ')'} ---")

    # Verify content (not just names) for every file the agent created.
    print("\n--- content match per file ---")
    n_match = 0
    n_diff = 0
    for path in sorted(orig_files):
        if not path:
            continue
        orig = await ws.shell(f"cat {path}")
        fresh = await fresh_ws.shell(f"cat {path}")
        orig_bytes = orig.stdout or b""
        fresh_bytes = fresh.stdout or b""
        if orig_bytes == fresh_bytes:
            print(f"  ✓ {path}  ({len(orig_bytes)} bytes match)")
            n_match += 1
        else:
            print(f"  ✗ {path}")
            print(f"      orig  ({len(orig_bytes)} bytes): "
                  f"{orig_bytes[:120]!r}")
            print(f"      fresh ({len(fresh_bytes)} bytes): "
                  f"{fresh_bytes[:120]!r}")
            n_diff += 1
    print(f"\n--- content summary: {n_match} match, {n_diff} differ ---")

    # Show /report.txt explicitly so the user can read what the agent wrote
    if "/report.txt" in orig_files:
        report = await fresh_ws.shell("cat /report.txt")
        body = (report.stdout or b"").decode()
        print(f"\n--- /report.txt from hydrated workspace "
              f"({len(body)} chars) ---")
        print(body)


asyncio.run(main())
