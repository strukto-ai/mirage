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

from camel.agents import ChatAgent
from camel.messages import BaseMessage
from camel.models import ModelFactory
from camel.types import ModelPlatformType, ModelType
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.agents.camel import MirageFileToolkit, MirageTerminalToolkit
from mirage.vfs.ram import RAMVFS

load_dotenv(".env.development")

ram = RAMVFS()
ws = Workspace({"/": ram}, mode=MountMode.WRITE)

terminal = MirageTerminalToolkit(ws)
files = MirageFileToolkit(ws)

model = ModelFactory.create(
    model_platform=ModelPlatformType.OPENAI,
    model_type=ModelType.GPT_5_MINI,
)

agent = ChatAgent(
    system_message=BaseMessage.make_assistant_message(
        role_name="Mirage Camel Agent",
        content=("You operate over a Mirage virtual filesystem mounted at /. "
                 "Use the file toolkit to write structured files and the "
                 "terminal toolkit to run shell commands. Paths start at /."),
    ),
    model=model,
    tools=[*terminal.get_tools(), *files.get_tools()],
)

task = ("Write a CSV at /data/numbers.csv with columns name,value and 3 rows. "
        "Then list /data and read the file back.")


async def main():
    response = await asyncio.to_thread(agent.step, task)
    print(response.msgs[-1].content)
    listing = await ws.shell("find / -type f")
    print((listing.stdout or b"").decode())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    finally:
        terminal.close()
        files.close()
