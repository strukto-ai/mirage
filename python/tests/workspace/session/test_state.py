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
from mirage.types import HiddenVars
from mirage.workspace.session import Session
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.state import (env_snapshot, session_view,
                                            visible_env)


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


def _hidden_view(
        policies: Policies | None = None) -> tuple[SessionView, Session]:
    session = Session(session_id="s",
                      cwd="/",
                      env={
                          "PUBLIC": "1",
                          "SLACK_TOKEN": "xoxb",
                          "AWS_SECRET_KEY": "k"
                      },
                      hidden_vars=HiddenVars(names=("SLACK_TOKEN", ),
                                             patterns=("AWS_*", )))
    return session_view(session, policies), session


def test_hidden_var_reads_as_unset():
    view, _session = _hidden_view()
    assert view.get("SLACK_TOKEN") is None
    assert view.get("AWS_SECRET_KEY") is None
    assert view.get("PUBLIC") == "1"


def test_snapshot_omits_hidden_vars():
    # Every copy-out routes through env_snapshot, so one omission here
    # is invisibility in inv.env, RunArgs.env and the env builtin at
    # once.
    view, _session = _hidden_view()
    snap = view.snapshot()
    assert "SLACK_TOKEN" not in snap
    assert "AWS_SECRET_KEY" not in snap
    assert snap["PUBLIC"] == "1"


def test_setting_a_hidden_var_is_refused_and_leaves_it_intact():
    # A write that landed would clobber the real value the host's
    # wiring still reads, and a write that silently vanished would be a
    # swallow; the door refuses loudly instead, the vars twin of EACCES
    # on a create into hidden path space.

    async def run():
        view, session = _hidden_view()
        with pytest.raises(PolicyDenied):
            await view.set("SLACK_TOKEN", "fake")
        assert session.env["SLACK_TOKEN"] == "xoxb"

    asyncio.run(run())


def test_unsetting_a_hidden_var_is_quiet_and_writes_nothing():
    # Hidden reads as unset, and bash's unset of a missing name is a
    # quiet no-op; popping the real value would let a session mutate
    # state it cannot see.

    async def run():
        view, session = _hidden_view()
        await view.unset("SLACK_TOKEN")
        assert session.env["SLACK_TOKEN"] == "xoxb"

    asyncio.run(run())


def test_a_hidden_readonly_var_reports_not_readonly():
    # is_readonly answers about the session's visible world; saying
    # "readonly" about a name that reads as unset would leak it.
    view, session = _hidden_view()
    session.readonly_vars.add("SLACK_TOKEN")
    assert not view.is_readonly("SLACK_TOKEN")


def test_visible_env_is_the_raw_dict_when_nothing_is_hidden():
    # $X expansion is the hot path; no hiding means no wrapper and no
    # copy.
    session = Session(session_id="s", cwd="/", env={"A": "1"})
    assert visible_env(session) is session.env


def test_visible_env_filters_reads_without_copying():
    _view_unused, session = _hidden_view()
    env = visible_env(session)
    assert env.get("SLACK_TOKEN") is None
    assert "AWS_SECRET_KEY" not in env
    assert env["PUBLIC"] == "1"
    assert sorted(env) == ["PUBLIC", "PWD"]
    assert len(env) == 2
    with pytest.raises(KeyError):
        env["SLACK_TOKEN"]
    session.env["NEW"] = "2"
    assert env["NEW"] == "2"
