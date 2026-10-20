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

from agents import Agent, ApplyPatchTool, Runner, ShellTool
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.agents.openai_agents import (
    MirageEditor,
    MirageShellExecutor,
    build_system_prompt,
)
from mirage.vfs.ram import RAMVFS
from mirage.workspace.snapshot import to_state_dict

load_dotenv(".env.development")


def make_workspace() -> Workspace:
    ram = RAMVFS()
    return Workspace({"/": ram}, mode=MountMode.WRITE)


async def main():
    ws = make_workspace()

    agent = Agent(
        name="Snapshot Demo",
        model="gpt-5.5-mini",
        instructions=await build_system_prompt(
            workspace=ws,
            extra_instructions=(
                "Write a 3-line note about Mirage to /report.txt "
                "using the shell tool."
            ),
        ),
        tools=[
            ShellTool(executor=MirageShellExecutor(ws)),
            ApplyPatchTool(editor=MirageEditor(ws)),
        ],
    )

    result = await Runner.run(agent, "Create the report.")
    print("Agent output:", result.final_output)

    find_orig = await ws.shell("find / -type f")
    orig_files = [
        p for p in (find_orig.stdout or b"").decode().strip().split("\n") if p
    ]

    print("\n--- Original files ---")
    print("\n".join(orig_files))

    print("\n--- Persisting snapshot ---")
    state = await to_state_dict(ws)
    print(f"snapshot mounts: {len(state['mounts'])}")

    print("\n--- Restoring into fresh workspace ---")
    fresh = await Workspace.from_state(state)
    find_fresh = await fresh.shell("find / -type f")
    fresh_files = [
        p for p in (find_fresh.stdout or b"").decode().strip().split("\n") if p
    ]
    print("\n".join(fresh_files))

    print("\n--- Per-file content match ---")
    matched = 0
    differ = 0
    for path in orig_files:
        a = (await ws.vfs.read(path)).decode()
        b = (await fresh.vfs.read(path)).decode()
        if a == b:
            print(f"  ✓ {path}  ({len(a)} chars match)")
            matched += 1
        else:
            print(f"  ✗ {path}")
            differ += 1
    print(f"\n--- content summary: {matched} match, {differ} differ ---")

    records = ws.vfs.records
    if records:
        total = sum(r.bytes for r in records)
        print(f"\n--- {len(records)} ops, {total:,} bytes ---")
        for r in records:
            print(
                f"  {r.op:<8} {r.source:<8} {r.bytes:>10} B "
                f"{r.duration_ms:>5} ms  {r.path}"
            )


asyncio.run(main())
