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
from pathlib import Path

from agents import Agent
from dotenv import load_dotenv
from openai import AsyncOpenAI

from mirage import MountMode, Workspace
from mirage.agents.openai_agents import MirageRunner, build_system_prompt
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource

load_dotenv(".env.development")

REPO_ROOT = Path(__file__).resolve().parents[3]
LOGO_PATH = REPO_ROOT / "logo" / "mirage-text-logo-light.svg"

ram = RAMResource()
disk = DiskResource(root=str(REPO_ROOT))
ws = Workspace({"/ram": ram, "/disk": disk}, mode=MountMode.READ)

agent = Agent(
    name="Multimodal Mirage Agent",
    model="gpt-5.4-mini",
    instructions=build_system_prompt(
        mount_info={
            "/ram": "In-memory filesystem",
            "/disk": "Read-only repo files",
        },
        extra_instructions=("You will be shown attachments inline. "
                            "Describe what you see in 1-2 sentences."),
    ),
)


async def main():
    if not os.environ.get("OPENAI_API_KEY"):
        print("OPENAI_API_KEY not set; skipping live agent run.")
        return

    png_path = "/ram/diagram.png"
    png_bytes = LOGO_PATH.read_bytes() if LOGO_PATH.exists() else b""
    if png_bytes:
        await ws.fs.write(png_path, png_bytes)

    txt_path = "/ram/notes.txt"
    await ws.fs.write(txt_path,
                      b"Status: green. INP < 200ms across all routes.\n")

    client = AsyncOpenAI()
    runner = MirageRunner(ws, client=client)

    paths: list[str] = [txt_path]
    if png_bytes:
        paths.append(png_path)

    print("=== build_blocks ===")
    blocks = await runner.build_blocks(
        "Summarize the attachments. List each by type.", paths)
    for b in blocks:
        kind = b["type"]
        head = (b.get("text") or b.get("image_url") or b.get("file_id")
                or "")[:60]
        print(f"  {kind}: {head}...")

    print()
    print("=== Runner.run ===")
    result = await runner.run_with_attachments(
        agent,
        "Summarize the attachments. List each by type.",
        paths,
    )
    print(result.final_output)


# Same flow works against any mounted resource. Example variants:
#
#   from mirage.resource.s3 import S3Resource, S3Config
#   ws = Workspace({"/s3": S3Resource(S3Config(...))}, mode=MountMode.READ)
#   await runner.run_with_attachments(agent, "...", ["/s3/bucket/img.png"])
#
#   from mirage.resource.slack import SlackResource, SlackConfig
#   ws = Workspace({"/slack": SlackResource(SlackConfig(...))})
#   await runner.run_with_attachments(
#       agent, "Summarize the PDF",
#       ["/slack/channels/general__C1/2026-04-28/files/report__F1.pdf"])

if __name__ == "__main__":
    asyncio.run(main())
