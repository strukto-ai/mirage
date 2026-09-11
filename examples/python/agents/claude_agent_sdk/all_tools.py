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
"""Drive every Mirage tool through the Claude Agent SDK.

Gives a Sonnet agent a task that exercises all six tools the Mirage
MCP server exposes (execute_command, read, write, edit, ls, grep)
against a RAM-backed workspace, prints each tool call, and verifies
the final file contents.

Usage:
    uv add 'mirage-ai[claude-agent-sdk]'
    python examples/python/agents/claude_agent_sdk/all_tools.py
"""

import asyncio

from claude_agent_sdk import (AssistantMessage, ResultMessage, ToolUseBlock,
                              query)
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.agents.claude_agent_sdk import build_options
from mirage.resource.ram import RAMResource

load_dotenv(".env.development")

PROMPT = """\
You are operating on a Mirage virtual filesystem via the mirage tools.
Use exactly one mirage tool per step and do them in order:
1. Use the ls tool on '/'.
2. Use the write tool to create '/notes.txt' with lines: alpha, beta, gamma.
3. Use the read tool on '/notes.txt'.
4. Use the edit tool on '/notes.txt' to replace 'beta' with 'BETA'.
5. Use the grep tool to search for 'a' in '/notes.txt'.
6. Use the execute_command tool to run: cat /notes.txt | sort | wc -l
Briefly report what each step returned.
"""

EXPECTED = {
    f"mcp__mirage__{name}"
    for name in ("execute_command", "read", "write", "edit", "ls", "grep")
}


async def main() -> None:
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    options = build_options(ws)
    options.model = "claude-sonnet-4-6"
    options.permission_mode = "bypassPermissions"

    used: list[str] = []
    async for msg in query(prompt=PROMPT, options=options):
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, ToolUseBlock):
                    used.append(block.name)
                    print(f"  -> {block.name}  {block.input}")
        elif isinstance(msg, ResultMessage):
            print("\n=== final report ===")
            print(msg.result)

    print("\n=== tools used ===")
    print(used)
    missing = EXPECTED - set(used)
    print("all six tools exercised:", not missing, "| missing:", missing
          or "none")

    final = await ws.fs.read("/notes.txt")
    print("\n=== /notes.txt final content (from the Mirage workspace) ===")
    print(final.decode("utf-8"))


if __name__ == "__main__":
    asyncio.run(main())
