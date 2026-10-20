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

from deepagents import create_deep_agent
from dotenv import load_dotenv
from langchain_anthropic import ChatAnthropic

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.langchain import (
    LangchainWorkspace,
    build_system_prompt,
    extract_text,
)

load_dotenv(".env.development")

ram = RAMVFS()
ws = Workspace({"/": ram}, mode=MountMode.WRITE)


async def main():
    agent = create_deep_agent(
        model=ChatAnthropic(model="claude-sonnet-4-6"),
        system_prompt=await build_system_prompt(
            mount_info={"/": "In-memory filesystem (read/write)"},
        ),
        backend=LangchainWorkspace(ws),
    )

    task = (
        "Create /hello.txt with 'Hello from Mirage!' and /data/numbers.csv "
        "with columns name,value and 3 sample rows. Then list all files."
    )
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": task}]}
    )

    for text in extract_text(result["messages"][-1:]):
        print(text)

    print("\n--- Files in workspace ---")
    find_all = await ws.shell("find / -type f")
    find_out = (find_all.stdout or b"").decode()
    print(find_out)

    for path in find_out.strip().split("\n"):
        if not path:
            continue
        content = (await ws.vfs.read(path)).decode()
        print(f"cat {path}:\n{content}")

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
