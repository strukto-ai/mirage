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
import gc
import sys

import pytest

from mirage.policy import Policy
from mirage.policy.mixin import SessionScopedMixin
from mirage.policy.types import CommandContext, Deny
from mirage.types import HiddenVars, Visibility
from mirage.utils.clock import ManualClock
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


class _FlaggedSessions(Policy, SessionScopedMixin):
    def __init__(self, ws: Workspace) -> None:
        self.ws = ws

    async def wants_for(self, method: str, session_id: str) -> bool:
        return self.ws.get_session(session_id).env.get("FLAG") == "on"

    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        return None


@pytest.mark.asyncio
async def test_a_policy_reads_the_session_while_a_task_waits():
    ws = Workspace({}, max_env=None)
    ws.registry.policies.add(_FlaggedSessions(ws))
    try:
        await ws.shell("FLAG=on")
        result = await ws.shell(': "${Y:=$(echo x)}"; echo "${#Y}"')
        assert await result.stderr_str() == ""
        assert await result.stdout_str() == "1\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_nested_expansion_error_releases_the_native_task_on_its_thread(
    monkeypatch,
):
    ws = Workspace({})
    raised = []
    gc.collect()
    enabled = gc.isenabled()
    try:
        gc.disable()
        monkeypatch.setattr(sys, "unraisablehook", raised.append)
        result = await ws.shell("echo $(echo $((1/0)))")
        assert "division by 0" in await result.stderr_str()
        del result
        await asyncio.to_thread(gc.collect)
        assert raised == []
    finally:
        if enabled:
            gc.enable()
        await ws.close()


@pytest.mark.asyncio
async def test_a_substitution_brings_its_end_time_to_the_words_after_it():
    ws = Workspace({}, clock=ManualClock(1_000_000))
    try:
        io = await ws.shell('SECONDS=0; echo "$(sleep 3)$SECONDS"')
        assert await io.stdout_str() == "3\n"
    finally:
        await ws.close()


# The count an unassigned SECONDS reads starts with the session's shell,
# so a later top-level line counts on from it.
@pytest.mark.asyncio
async def test_seconds_counts_from_the_session_s_first_line():
    clock = ManualClock(1_000_000)
    ws = Workspace({}, clock=clock, system_time="2026-01-01T00:00:00Z")
    try:
        await ws.shell("true")
        clock.advance(5)
        io = await ws.shell("echo $SECONDS")
        assert await io.stdout_str() == "5\n"
    finally:
        await ws.close()
