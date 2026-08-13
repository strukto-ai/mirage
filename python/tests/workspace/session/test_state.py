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

from mirage.ops.types import SessionView
from mirage.policy import Action, Deny, Policies, Policy, PolicyDenied
from mirage.policy.types import SessionContext
from mirage.workspace.session import Session
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.state import env_snapshot, session_view


class DenySecrets(Policy):

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        if ctx.key.startswith("SECRET"):
            return Deny("SECRET_* refused by policy\n")
        return None


def _view(policies: Policies | None = None) -> tuple[SessionView, Session]:
    session = Session(session_id="s", cwd="/", env={"A": "1"})
    return session_view(session, policies), session


def test_get_and_snapshot_read_the_session():
    view, session = _view()
    assert view.get("A") == "1"
    assert view.get("MISSING") is None
    snap = view.snapshot()
    assert snap["A"] == "1"
    snap["B"] = "2"
    assert "B" not in session.env


def test_set_and_unset_write_the_session():

    async def run():
        view, session = _view()
        await view.set("B", "2")
        assert session.env["B"] == "2"
        await view.unset("B")
        assert "B" not in session.env

    asyncio.run(run())


def test_set_is_general_over_variable_shapes():
    # One door for every write: a string stores a scalar, a list stores
    # a whole array, and the two storages stay exclusive.

    async def run():
        view, session = _view()
        await view.set("A", ["x", "y"])
        assert session.arrays["A"] == ["x", "y"]
        assert "A" not in session.env
        await view.set("A", "s")
        assert session.env["A"] == "s"
        assert "A" not in session.arrays

    asyncio.run(run())


def test_an_array_write_renders_the_gate_value_as_words():
    seen: list[str | None] = []

    class Capture(Policy):

        async def pre_session(self, ctx: SessionContext) -> Action | None:
            seen.append(ctx.value)
            return None

    async def run():
        view, _session = _view(Policies([Capture()]))
        await view.set("A", ["x", None, "y"])

    asyncio.run(run())
    assert seen == ["x y"]


def test_unset_of_a_missing_name_is_quiet():

    async def run():
        view, _session = _view()
        await view.unset("NEVER_SET")

    asyncio.run(run())


def test_readonly_refusal_is_typed():
    # The view owns the refusal so every writer states it the same way;
    # builtins catch the typed error and render their own bash wording.

    async def run():
        view, session = _view()
        session.readonly_vars.add("A")
        assert view.is_readonly("A")
        with pytest.raises(ReadonlyVariableError):
            await view.set("A", "2")
        with pytest.raises(ReadonlyVariableError):
            await view.unset("A")
        assert session.env["A"] == "1"

    asyncio.run(run())


def test_pre_session_gate_vetoes_a_write():

    async def run():
        policies = Policies()
        policies.add(DenySecrets())
        view, session = _view(policies)
        with pytest.raises(PolicyDenied):
            await view.set("SECRET_KEY", "x")
        assert "SECRET_KEY" not in session.env
        with pytest.raises(PolicyDenied):
            await view.unset("SECRET_KEY")
        await view.set("PUBLIC", "y")
        assert session.env["PUBLIC"] == "y"

    asyncio.run(run())


def test_env_snapshot_is_a_copy():
    session = Session(session_id="s", cwd="/", env={"A": "1"})
    snap = env_snapshot(session)
    assert snap == session.env
    assert snap is not session.env


def test_the_view_carries_no_session_handle():
    # The view is the whole capability: five facts, no way back to the
    # raw session object behind them.
    view, _session = _view()
    assert not hasattr(view, "session")
