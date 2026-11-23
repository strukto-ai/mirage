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

from openenv.core.env_server.mcp_types import CallToolAction, ListToolsAction
from openenv.core.env_server.types import Action, Observation

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.openenv import MirageAction, MirageOpenEnv
from mirage.workspace.workspace import Session

base = Workspace(
    {"/repo": RAMVFS()},
    mode=MountMode.WRITE,
    profiles={"default": {"commands": {"rm": "deny"}}},
)


async def reward(
    session: Session, action: Action, observation: Observation
) -> float:
    if not await session.vfs.exists("/repo/answer.txt"):
        return 0.0
    answer = await session.vfs.read("/repo/answer.txt")
    return 1.0 if answer.strip() == b"3" else 0.0


async def done(
    session: Session, action: Action, observation: Observation
) -> bool:
    return await session.vfs.exists("/repo/answer.txt")


def shell(command: str) -> MirageAction:
    return MirageAction(tool="shell", arguments={"command": command})


async def main() -> None:
    await base.shell(
        "mkdir -p /repo/src && printf 'a\\nb\\nc\\n' > /repo/src/lines.txt"
    )
    env = MirageOpenEnv(base, reward=reward, done=done, max_steps=8)
    for episode in range(2):
        reset = await env.reset_async(seed=episode)
        print(f"episode {episode}: cwd={reset.cwd}")
        for action in (
            shell("cd /repo && wc -l < src/lines.txt"),
            shell("rm src/lines.txt"),
            shell("wc -l < src/lines.txt > answer.txt"),
        ):
            obs = await env.step_async(action)
            print(
                f"  $ {action.arguments['command']}\n"
                f"    exit={obs.exit_code} reward={obs.reward} "
                f"done={obs.done} stdout={obs.stdout!r}"
            )
            if obs.refusal is not None:
                print(f"    refused: {obs.refusal.reason}")
        print(f"  state: {env.state.step_count} steps")

    tools = await env.step_async(ListToolsAction())
    print(f"MCP tools: {len(tools.tools)}")
    called = await env.step_async(
        CallToolAction(
            tool_name="vfs_exists", arguments={"path": "/repo/answer.txt"}
        )
    )
    print(f"vfs_exists: {called.result.content[0].text}")
    await env.aclose()
    listing = await base.shell("ls /repo")
    print(
        f"base workspace still holds: {(await listing.stdout_str()).split()}"
    )
    await base.close()


asyncio.run(main())
