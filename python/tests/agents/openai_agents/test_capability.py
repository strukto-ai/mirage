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
import io
from pathlib import Path

import pytest
from agents import Runner
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.capabilities import Capabilities
from agents.sandbox.session.base_sandbox_session import BaseSandboxSession
from agents.sandbox.types import ExecResult

from mirage.agents.openai_agents.capability import (
    MirageCapability,
    mirage_session,
)
from mirage.agents.openai_agents.constants import (
    MOUNTS_INTRO,
    NOT_MIRAGE_SESSION,
)
from mirage.agents.openai_agents.sandbox import MirageSandboxClient
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


class ForeignSession(BaseSandboxSession):
    async def _exec_internal(
        self, *command: str | Path, timeout: float | None = None
    ) -> ExecResult:
        raise NotImplementedError

    async def read(self, path: Path, *, user=None) -> io.IOBase:
        raise NotImplementedError

    async def write(self, path: Path, data: io.IOBase, *, user=None) -> None:
        raise NotImplementedError

    async def running(self) -> bool:
        return True

    async def persist_workspace(self) -> io.IOBase:
        raise NotImplementedError

    async def hydrate_workspace(self, data: io.IOBase) -> None:
        raise NotImplementedError


def _workspace() -> Workspace:
    return Workspace(
        {
            "/": (RAMVFS(), MountMode.WRITE),
            "/data": (RAMVFS(), MountMode.READ),
        },
        mode=MountMode.WRITE,
    )


def test_instructions_list_each_mount_with_its_mode():
    async def _run():
        session = await MirageSandboxClient(_workspace()).create()
        capability = MirageCapability()
        capability.bind(session)
        text = await capability.instructions(Manifest(root="/"))
        assert text is not None
        assert text.startswith(MOUNTS_INTRO)
        assert "## `/data`\n\nBackend: `ram`. Access: read-only." in text

    asyncio.run(_run())


def test_bind_refuses_a_session_from_another_backend():
    with pytest.raises(TypeError, match=NOT_MIRAGE_SESSION):
        MirageCapability().bind(ForeignSession())


def test_mirage_session_unwraps_the_sdk_wrapper():
    async def _run():
        client = MirageSandboxClient(_workspace())
        wrapped = await client.create()
        assert mirage_session(wrapped).workspace is client._ws

    asyncio.run(_run())


def test_the_agent_prompt_carries_the_mounts(scripted_model):
    async def _run():
        model = scripted_model([])
        agent = SandboxAgent(
            name="mounts",
            model=model,
            capabilities=[*Capabilities.default(), MirageCapability()],
        )
        config = RunConfig(
            sandbox=SandboxRunConfig(client=MirageSandboxClient(_workspace())),
            tracing_disabled=True,
        )
        await Runner.run(agent, "hi", run_config=config)
        prompt = model.instructions[0]
        assert prompt is not None
        assert MOUNTS_INTRO in prompt
        assert "/data" in prompt

    asyncio.run(_run())
