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
from openai import AsyncOpenAI

from mirage import MountMode, Workspace
from mirage.agents.openai_agents import MirageRunner, MirageSandboxClient
from mirage.resource.slack import SlackConfig, SlackResource

load_dotenv(".env.development")

slack = SlackResource(config=SlackConfig(
    token=os.environ["SLACK_BOT_TOKEN"],
    search_token=os.environ.get("SLACK_USER_TOKEN"),
))
ws = Workspace({"/slack": (slack, MountMode.READ)}, mode=MountMode.READ)
client = MirageSandboxClient(ws)

navigator = SandboxAgent(
    name="path-resolver",
    model="gpt-5.4-mini",
    instructions=(f"{ws.file_prompt}\n\n"
                  "Use shell tools (ls, find) to locate files. "
                  "Reply with absolute paths only, one per line."),
)

analyst = SandboxAgent(
    name="analyst",
    model="gpt-5.4-mini",
    instructions=(
        f"{ws.file_prompt}\n\n"
        "You have shell tools (ls, find, cat, grep, ...) and view_image. "
        "Some files may already be attached to this message — read them "
        "directly. For images you discover later, call view_image. "
        "Answer using only attachments and confirmed file contents."),
)


async def mirage_run(task: str) -> str:
    """Run a task with both pre-attached multimodal context and live tools.

    Pipeline:
      1. Navigator agent uses shell tools to resolve which paths the task
         needs.
      2. MirageRunner pre-attaches every resolved path as a multimodal
         block — input_image (PNG/JPEG/GIF, base64 data URI), input_file
         (PDF, uploaded via OpenAI Files API), or input_text otherwise.
      3. The analyst SandboxAgent receives those blocks AND retains all
         shell tools + native view_image. It can read the pre-attached
         content directly OR call view_image / cat for anything else
         it discovers mid-run.

    Args:
        task (str): Natural-language task referring to files in the VFS.

    Returns:
        str: The analyst's final output.
    """
    nav = await Runner.run(
        navigator,
        f"Find every file this request refers to: {task}",
        run_config=RunConfig(sandbox=SandboxRunConfig(client=client)),
        max_turns=20,
    )
    print("  navigator raw output:")
    for line in nav.final_output.strip().splitlines():
        print(f"    {line!r}")
    paths = [
        line.strip().strip("`").strip()
        for line in nav.final_output.strip().splitlines()
        if line.strip().startswith("/")
    ]
    print(f"  resolved paths: {paths}")

    runner = MirageRunner(ws, client=AsyncOpenAI())
    blocks = await runner.build_blocks(task, paths)
    out = await Runner.run(
        analyst,
        [{
            "role": "user",
            "content": blocks
        }],
        run_config=RunConfig(sandbox=SandboxRunConfig(client=client)),
        max_turns=20,
    )
    return out.final_output


async def main():
    task = "Summarize the latest PNG and PDF in the slack general channel."
    print(f"=== Task: {task} ===")
    print()
    result = await mirage_run(task)
    print()
    print("=== Analyst output ===")
    print(result)


# Why both pre-attach AND view_image?
#
# - PNG/JPEG/GIF: either path works. view_image is convenient for images
#   the agent discovers mid-run; pre-attach is convenient for images
#   already known up front.
# - PDF: ONLY pre-attach works. The OpenAI Agents SDK has no view_file
#   builtin for tool outputs (issue #341). PDFs must be uploaded to the
#   Files API and added as input_file blocks in a user message. We do
#   that before the agent run so the model receives full PDF text and
#   rendered pages.
# - input_text: any non-binary content the agent might want pre-loaded.
#
# Resource-agnostic: ws.fs.read(path) routes via the workspace mount
# registry, so the same flow works for /s3/...png, /disk/...pdf,
# /slack/.../files/..., etc.

if __name__ == "__main__":
    asyncio.run(main())
