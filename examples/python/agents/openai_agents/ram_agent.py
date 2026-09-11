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
from mirage.agents.openai_agents import (MirageEditor, MirageShellExecutor,
                                         build_system_prompt)
from mirage.resource.ram import RAMResource

load_dotenv(".env.development")

ram = RAMResource()
ws = Workspace({"/": ram}, mode=MountMode.WRITE)

system_prompt = build_system_prompt(
    mount_info={"/": "In-memory filesystem (read/write)"},
    extra_instructions=("All file paths start from /. "
                        "For example: /hello.txt, /data/numbers.csv. "
                        "Use the shell tool to run commands like: "
                        "echo 'content' > /hello.txt, mkdir /data, "
                        "cat /hello.txt, ls /."),
)

agent = Agent(
    name="Mirage RAM Agent",
    model="gpt-5.5-mini",
    instructions=system_prompt,
    tools=[
        ShellTool(executor=MirageShellExecutor(ws)),
        ApplyPatchTool(editor=MirageEditor(ws)),
    ],
)

task = ("Create a file /hello.txt with the content 'Hello from Mirage!'. "
        "Then create a directory /data and write a CSV file /data/numbers.csv "
        "with columns: name, value. Add 3 rows of sample data. "
        "Finally, list all files and cat the CSV.")


async def main():
    result = await Runner.run(agent, task)
    print(result.final_output)

    print("\n--- Verifying files in workspace ---")
    find_all = await ws.execute("find / -type f")
    print(f"find / -type f:\n{(find_all.stdout or b'').decode()}")

    for path in (find_all.stdout or b"").decode().strip().split("\n"):
        path = path.strip()
        if not path:
            continue
        cat_result = await ws.execute(f"cat {path}")
        print(f"cat {path}:\n{(cat_result.stdout or b'').decode()}")

    records = ws.fs.records
    if records:
        total = sum(r.bytes for r in records)
        print(f"--- {len(records)} ops, {total:,} bytes ---")
        for r in records:
            print(f"  {r.op:<8} {r.source:<8} {r.bytes:>10,} B "
                  f"{r.duration_ms:>5} ms  {r.path}")


asyncio.run(main())
