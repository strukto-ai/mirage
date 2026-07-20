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

from agno.agent import Agent
from agno.models.openai import OpenAIChat
from dotenv import load_dotenv

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.agno import MirageToolkit

load_dotenv(".env.development")

ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)

agent = Agent(
    model=OpenAIChat(id="gpt-4o"),
    tools=[MirageToolkit(ws)],
    instructions=("You have access to a virtual filesystem via shell "
                  "tools. Use them to explore and read files."),
    markdown=True,
)

TASK = "List all files under /data and show the contents of each one."


async def main() -> None:
    await ws.execute('echo "hello from mirage" | tee /data/hello.txt')
    await agent.aprint_response(TASK)

    records = ws.ops.records
    if records:
        total = sum(r.bytes for r in records)
        print(f"\n--- {len(records)} ops, {total:,} bytes ---")
        for r in records:
            print(f"  {r.op:<8} {r.source:<8} {r.bytes:>10,} B "
                  f"{r.duration_ms:>5} ms  {r.path}")


if __name__ == "__main__":
    asyncio.run(main())
