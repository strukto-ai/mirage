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

from agents import Agent, ApplyPatchTool, Runner, ShellTool
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.agents.openai_agents import (
    MirageEditor,
    MirageShellExecutor,
    build_system_prompt,
)
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
    )
)
slack = SlackVFS(config=SlackConfig(token=os.environ["SLACK_BOT_TOKEN"]))

ws = Workspace(
    {
        "/": ram,
        "/s3": (s3, MountMode.READ),
        "/slack": (slack, MountMode.READ),
    },
    mode=MountMode.WRITE,
)


async def main():
    agent = Agent(
        name="Mirage Multi-VFS Agent",
        model="gpt-5.5",
        instructions=await build_system_prompt(workspace=ws),
        tools=[
            ShellTool(executor=MirageShellExecutor(ws)),
            ApplyPatchTool(editor=MirageEditor(ws)),
        ],
    )

    task = (
        "1. Find the date of the latest Slack message in the general channel. "
        "2. Summarize the parquet file in /s3/data/. "
        "Write your findings to /report.txt."
    )

    result = await Runner.run(agent, task)
    print(result.final_output)

    find_all = await ws.shell("find / -type f")
    print("\n--- Files in workspace ---")
    print((find_all.stdout or b"").decode())

    records = ws.vfs.records
    if records:
        total = sum(r.bytes for r in records)
        print(f"--- {len(records)} ops, {total:,} bytes ---")
        for r in records:
            print(
                f"  {r.op:<8} {r.source:<8} {r.bytes:>10} B "
                f"{r.duration_ms:>5} ms  {r.path}"
            )


asyncio.run(main())
