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

import pytest

from mirage.policy import Policy
from mirage.policy.types import Deny, SessionContext
from mirage.types import HiddenVars, Visibility
from mirage.workspace import Workspace
from mirage.workspace.session import task as task_module
from mirage.workspace.session.state import seed_var


@pytest.mark.asyncio
async def test_a_long_value_operator_pauses_where_a_cancel_lands(monkeypatch):
    ws = Workspace({}, max_env=None)
    pauses: list[int] = []

    async def turn() -> None:
        pauses.append(1)
        if len(pauses) == 1:
            line.cancel()
        await asyncio.sleep(0)

    try:
        await ws.shell("shopt -s extglob")
        monkeypatch.setattr(task_module, "task_turn", turn)
        line = asyncio.create_task(
            ws.shell("x=${X//+(?)/x}; touched=yes", env={"X": "a" * 2_000_000})
        )
        with pytest.raises(asyncio.CancelledError):
            await line
        assert 1 <= len(pauses) < 20
        monkeypatch.undo()
        result = await ws.shell('printf "%s\\n" "${touched-unset}"')
        assert await result.stdout_str() == "unset\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_short_value_operator_never_pauses(monkeypatch):
    ws = Workspace({})
    pauses: list[int] = []

    async def turn() -> None:
        pauses.append(1)

    monkeypatch.setattr(task_module, "task_turn", turn)
    try:
        result = await ws.shell('x=hello; echo "${x//l/L} ${x^^[lo]}"')
        assert await result.stdout_str() == "heLLo heLLO\n"
        assert pauses == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profile_changed_mid_task_hides_its_names(monkeypatch):
    ws = Workspace({}, max_env=None)
    session = ws.get_session(ws.default_session_id)
    hidden = Visibility(vars=HiddenVars(names=("TOKEN",)))

    async def turn() -> None:
        session.visibility = hidden
        await asyncio.sleep(0)

    try:
        await ws.shell("shopt -s extglob; TOKEN=t")
        seed_var(session, "X", "a" * 50_000)
        monkeypatch.setattr(task_module, "task_turn", turn)
        result = await ws.shell('x=${X//+(?)/x}; echo "${TOKEN-unset}"')
        assert session.visibility is hidden
        assert await result.stdout_str() == "unset\n"
    finally:
        await ws.close()


class _DenyY(Policy):
    async def pre_session(self, ctx: SessionContext) -> Deny | None:
        return Deny("Y refused") if ctx.key == "Y" else None


@pytest.mark.asyncio
async def test_a_policy_added_mid_task_hears_the_writes_after_it(monkeypatch):
    ws = Workspace({}, max_env=None)
    session = ws.get_session(ws.default_session_id)
    added: list[Policy] = []

    async def turn() -> None:
        if not added:
            added.append(_DenyY())
            ws.registry.policies.add(added[0])
        await asyncio.sleep(0)

    try:
        await ws.shell("shopt -s extglob")
        seed_var(session, "X", "a" * 50_000)
        monkeypatch.setattr(task_module, "task_turn", turn)
        await ws.shell(': "${Y:=${X//+(?)/x}}"')
        result = await ws.shell('echo "${Y-unset}"')
        assert added
        assert await result.stdout_str() == "unset\n"
    finally:
        await ws.close()
