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
from mirage.shell.errors import ArithError
from mirage.shell.variable import ManagedRef, ShellVar, VarAttr
from mirage.types import HiddenVars
from mirage.workspace.session import Session
from mirage.workspace.session.errors import ReadonlyVariableError
from mirage.workspace.session.session import vars_from_env
from mirage.workspace.session.state import (element_index, env_snapshot,
                                            next_random, seed_var,
                                            session_elements, session_view,
                                            set_attr, set_var,
                                            strip_key_quotes, subscript_index,
                                            visible_env)


class DenySecrets(Policy):

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        if ctx.key.startswith("SECRET"):
            return Deny("SECRET_* refused by policy\n")
        return None


def _view(policies: Policies | None = None) -> tuple[SessionView, Session]:
    session = Session(session_id="s", cwd="/", vars=vars_from_env({"A": "1"}))
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
        set_attr(session, "A", VarAttr.READONLY)
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
    session = Session(session_id="s", cwd="/", vars=vars_from_env({"A": "1"}))
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
                      vars=vars_from_env({
                          "PUBLIC": "1",
                          "SLACK_TOKEN": "xoxb",
                          "AWS_SECRET_KEY": "k"
                      }),
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
    set_attr(session, "SLACK_TOKEN", VarAttr.READONLY)
    assert not view.is_readonly("SLACK_TOKEN")


def test_visible_env_matches_the_scalars_when_nothing_is_hidden():
    # $X expansion is the hot path; no hiding means no wrapper and no
    # copy.
    session = Session(session_id="s", cwd="/", vars=vars_from_env({"A": "1"}))
    assert dict(visible_env(session)) == dict(session.env)


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
    seed_var(session, "NEW", "2")
    assert env["NEW"] == "2"


def test_a_shaped_write_gates_the_value_that_lands():
    # `declare -l profile; profile=ADMIN` stores `admin`, so a rule refusing
    # `admin` has to see `admin`, not the raw text: coercion runs
    # before the gate.
    seen: list[str | None] = []

    class Capture(Policy):

        async def pre_session(self, ctx: SessionContext) -> Action | None:
            seen.append(ctx.value)
            if ctx.value == "admin":
                return Deny("no admin\n")
            return None

    async def run():
        view, session = _view(Policies([Capture()]))
        seed_var(session, "profile", "")
        set_attr(session, "profile", VarAttr.LOWER)
        with pytest.raises(PolicyDenied):
            await view.set("profile", "ADMIN")
        assert session.env["profile"] == ""
        seed_var(session, "n", "0")
        set_attr(session, "n", VarAttr.INTEGER)
        await view.set("n", "3+4")
        assert session.env["n"] == "7"

    asyncio.run(run())
    assert seen == ["admin", "7"]


def test_integer_coercion_resolves_elements():
    # `n=a[1]+1` under `-i` reads the element, as bash does, through
    # the same resolver every other arithmetic entry point uses.
    async def run():
        view, session = _view()
        seed_var(session, "a", ["1", "2"])
        seed_var(session, "m", {"x": "4"})
        seed_var(session, "n", "0")
        set_attr(session, "n", VarAttr.INTEGER)
        await view.set("n", "a[1]+1")
        assert session.env["n"] == "3"
        await view.set("n", "m[x]+1")
        assert session.env["n"] == "5"
        await view.set("n", 'm["x"]+1')
        assert session.env["n"] == "5"
        await view.set("n", "a[5]+1")
        assert session.env["n"] == "1"
        with pytest.raises(ArithError):
            await view.set("n", "1+")

    asyncio.run(run())


def _element_session() -> Session:
    session = Session(session_id="s", cwd="/")
    seed_var(session, "m", {"a": "1", "k5": "9", "0": "z"})
    seed_var(session, "arr", ["10", "20", "30"])
    seed_var(session, "s5", "5")
    seed_var(session, "i", "1")
    return session


def test_strip_key_quotes():
    assert strip_key_quotes('"x"') == "x"
    assert strip_key_quotes("'x'") == "x"
    assert strip_key_quotes("x") == "x"
    assert strip_key_quotes('"x') == '"x'
    assert strip_key_quotes('""') == ""


def test_element_index_int_arith_and_error():
    assert element_index("3", {}) == 3
    assert element_index(" -2 ", {}) == -2
    assert element_index("i+1", {"i": "1"}) == 2
    # An unresolvable expression indexes element 0, bash's
    # unset-name-is-zero arithmetic rule.
    assert element_index("$bad", {}) == 0


def test_subscript_index_lands_its_assignments_and_seeds_random():
    session = Session(session_id="s", cwd="/")
    seed_var(session, "i", "1")
    session.vars["RANDOM"] = ShellVar("1")

    async def run():
        assert await subscript_index(session, "3") == 3
        assert await subscript_index(session, "i+1") == 2
        # The subscript's assignment lands, bash's `a[x=3]`.
        assert await subscript_index(session, "x=3") == 3
        assert session.vars["x"].value == "3"
        # One that fails lands what it assigned before failing, then
        # raises in bash's words rather than reading element 0.
        with pytest.raises(ArithError, match=r"^y=4, 1/0: "):
            await subscript_index(session, "y=4, 1/0")
        assert session.vars["y"].value == "4"
        # A seed reaches the generator, and the draw after it advances
        # the session past it.
        assert await subscript_index(session, "RANDOM=42, RANDOM") == 17772
        assert next_random(session, session.vars["RANDOM"].value) == 26794
        # Through a door, a refusal is the gate's.
        view = session_view(session, Policies([DenySecrets()]))
        with pytest.raises(PolicyDenied):
            await subscript_index(session, "SECRET_N=1", view)
        assert "SECRET_N" not in session.env

    asyncio.run(run())


def test_resolve_assoc_is_literal():
    session = _element_session()
    ops = session_elements(session)
    assert ops.resolve("m", "a", {}) == "a"
    assert ops.resolve("m", '"a"', {}) == "a"
    # A key spelled like arithmetic stays a key.
    assert ops.resolve("m", "1+1", {}) == "1+1"


def test_resolve_indexed_evaluates_and_wraps_negative():
    session = _element_session()
    ops = session_elements(session)
    assert ops.resolve("arr", "1+1", {}) == "2"
    assert ops.resolve("arr", "i", {"i": "2"}) == "2"
    assert ops.resolve("arr", "-1", {}) == "2"
    with pytest.raises(ArithError):
        ops.resolve("arr", "-9", {})


def test_read_by_kind():
    session = _element_session()
    ops = session_elements(session)
    assert ops.read("m", "a") == "1"
    assert ops.read("m", "zz") is None
    assert ops.read("arr", "1") == "20"
    assert ops.read("arr", "9") is None
    # A scalar answers as element 0 of a one-element array.
    assert ops.read("s5", "0") == "5"
    assert ops.read("s5", "1") is None
    assert ops.read("missing", "0") is None


def _managed(value: str | None) -> ShellVar:
    return ShellVar(value,
                    frozenset({VarAttr.EXPORT}),
                    managed=ManagedRef("env", "", "TOKEN", False))


def test_set_var_detaches_a_fetched_managed_var():

    async def run():
        view, session = _view()
        session.vars["TOKEN"] = _managed("s3cr3t")
        await view.set("TOKEN", "mine")
        var = session.vars["TOKEN"]
        assert var.managed is None
        assert var.value == "mine"
        assert var.attrs == frozenset({VarAttr.EXPORT})

    asyncio.run(run())


def test_set_var_detaches_an_unfetched_managed_var():

    async def run():
        view, session = _view()
        session.vars["TOKEN"] = _managed(None)
        await view.set("TOKEN", "mine")
        var = session.vars["TOKEN"]
        assert var.managed is None
        assert var.value == "mine"

    asyncio.run(run())


def test_unset_var_deletes_a_managed_name_quietly():

    async def run():
        view, session = _view()
        session.vars["TOKEN"] = _managed("s3cr3t")
        await view.unset("TOKEN")
        assert "TOKEN" not in session.vars

    asyncio.run(run())


def test_profile_reads_the_session_profile():
    view, session = _view()
    assert view.profile() is None
    session.profile = "admin"
    assert view.profile() == "admin"


def test_a_failing_coercion_lands_what_it_assigned():
    # bash: `declare -i n; x='y=5,1/0'; n=x` refuses the assignment but
    # leaves y at 5, and a RANDOM seed in the expression seeds.
    session = Session(session_id="s", cwd="/")
    session.vars["RANDOM"] = ShellVar("1")
    set_attr(session, "n", VarAttr.INTEGER)
    seed_var(session, "x", "y=5,1/0")

    async def run():
        with pytest.raises(ArithError):
            await set_var(session, None, "n", "x")
        assert session.vars["y"].value == "5"
        assert "n" not in session.env
        seed_var(session, "x", "RANDOM=42,1/0")
        with pytest.raises(ArithError):
            await set_var(session, None, "n", "x")
        assert next_random(session, session.vars["RANDOM"].value) == 17772

    asyncio.run(run())
