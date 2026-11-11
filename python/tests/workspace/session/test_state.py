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

from mirage.context.session_context import (
    reset_caller,
    set_current_session,
)
from mirage.policy import PolicyDenied
from mirage.shell.array import make_array
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ArithError, ReadonlyVariableError
from mirage.shell.parse.parse import parse_program
from mirage.shell.variable import ManagedRef, ShellVar, VarAttr
from mirage.types import HiddenVars, Visibility
from mirage.view.types import SessionView
from mirage.workspace.session import SessionState
from mirage.workspace.session.session import vars_from_env
from mirage.workspace.session.state import (
    assign_element,
    element_is_set,
    env_snapshot,
    in_call_env,
    outlive_call,
    positional_params,
    seed_var,
    session_view,
    set_attr,
    set_positional_params,
    set_var,
    subscript_index,
    visible_arrays,
    visible_assocs,
    visible_env,
)


def _view() -> tuple[SessionView, SessionState]:
    session = SessionState(
        session_id="s", cwd="/", vars=vars_from_env({"A": "1"})
    )
    return session_view(session), session


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
    # One entry point for every write: a string stores a scalar, or element
    # 0 of an array it lands on as bash's `A=s` does, a list stores a whole
    # array, and the two storages stay exclusive.

    async def run():
        view, session = _view()
        await view.set("A", make_array(["x", "y"]))
        assert session.arrays["A"] == make_array(["x", "y"])
        assert "A" not in session.env
        await view.set("A", "s")
        assert session.arrays["A"] == make_array(["s", "y"])
        assert "A" not in session.env
        await view.set("S", "s")
        assert session.env["S"] == "s"
        assert "S" not in session.arrays

    asyncio.run(run())


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


def test_env_snapshot_is_a_copy():
    session = SessionState(
        session_id="s", cwd="/", vars=vars_from_env({"A": "1"})
    )
    snap = env_snapshot(session)
    assert snap == {"A": "1", "PWD": "/"}
    assert snap is not session.env


def test_the_view_carries_no_session_handle():
    # The view is the whole capability: five facts, no way back to the
    # raw session object behind them.
    view, _session = _view()
    assert not hasattr(view, "session")


def _hidden_view() -> tuple[SessionView, SessionState]:
    session = SessionState(
        session_id="s",
        cwd="/",
        vars=vars_from_env(
            {"PUBLIC": "1", "SLACK_TOKEN": "xoxb", "AWS_SECRET_KEY": "k"}
        ),
        visibility=Visibility(
            vars=HiddenVars(names=("SLACK_TOKEN",), patterns=("AWS_*",))
        ),
    )
    return session_view(session), session


def test_hidden_var_reads_as_unset():
    view, _session = _hidden_view()
    assert view.get("SLACK_TOKEN") is None
    assert view.get("AWS_SECRET_KEY") is None
    assert view.get("PUBLIC") == "1"


def test_snapshot_omits_hidden_vars():
    # Every copy-out routes through env_snapshot, so one omission here
    # is invisibility in a command's and a runtime's ctx.env and the env
    # builtin at once.
    view, _session = _hidden_view()
    snap = view.snapshot()
    assert "SLACK_TOKEN" not in snap
    assert "AWS_SECRET_KEY" not in snap
    assert snap["PUBLIC"] == "1"


def test_setting_a_hidden_var_is_refused_and_leaves_it_intact():
    # A write that landed would clobber the real value the host's
    # wiring still reads, and a write that silently vanished would be a
    # swallow; the session view refuses loudly instead, the vars twin of EACCES
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
    session = SessionState(
        session_id="s", cwd="/", vars=vars_from_env({"A": "1"})
    )
    assert dict(visible_env(session)) == dict(session.env)


def test_visible_env_filters_reads_without_copying():
    _view_unused, session = _hidden_view()
    env = visible_env(session)
    assert env.get("SLACK_TOKEN") is None
    assert "AWS_SECRET_KEY" not in env
    assert env["PUBLIC"] == "1"
    assert sorted(env) == ["IFS", "OPTERR", "OPTIND", "PATH", "PUBLIC", "PWD"]
    assert len(env) == 6
    with pytest.raises(KeyError):
        env["SLACK_TOKEN"]
    seed_var(session, "NEW", "2")
    assert env["NEW"] == "2"


def test_integer_coercion_resolves_elements():
    # `n=a[1]+1` under `-i` reads the element, as bash does, through
    # the same resolver every other arithmetic entry point uses.
    async def run():
        view, session = _view()
        seed_var(session, "a", make_array(["1", "2"]))
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


def _element_session() -> SessionState:
    session = SessionState(session_id="s", cwd="/")
    seed_var(session, "m", {"a": "1", "k5": "9", "0": "z"})
    seed_var(session, "arr", make_array(["10", "20", "30"]))
    seed_var(session, "s5", "5")
    seed_var(session, "i", "1")
    return session


def test_element_is_set():
    session = _element_session()

    async def run():
        assert await element_is_set(session, "m[a]")
        assert await element_is_set(session, 'm["a"]')
        assert not await element_is_set(session, "m[zz]")
        # The subscript is the key verbatim, never arithmetic.
        assert not await element_is_set(session, "m[1+1]")
        assert await element_is_set(session, "m[@]")
        assert await element_is_set(session, "arr[2]")
        assert not await element_is_set(session, "arr[9]")
        assert await element_is_set(session, "arr[@]")
        # An indexed subscript is arithmetic, and what it assigns lands.
        assert await element_is_set(session, "arr[j=2]")
        assert session.vars["j"].value == "2"
        # A bare name over an array checks element 0 (the literal key
        # "0" for an associative one).
        assert await element_is_set(session, "m")
        assert await element_is_set(session, "arr")
        assert await element_is_set(session, "s5")
        assert not await element_is_set(session, "missing")
        assert not await element_is_set(session, "not a ref")
        # PIPESTATUS answers from the shell's own bookkeeping.
        session.pipe_status = (0, 1)
        assert await element_is_set(session, "PIPESTATUS[1]")
        assert not await element_is_set(session, "PIPESTATUS[2]")

    asyncio.run(run())


def test_assign_element_assoc_and_append():
    session = _element_session()

    async def run():
        assert await assign_element(session, "m", "b", "2") == "ok"
        assert (
            await assign_element(session, "m", "b", "x", append=True) == "ok"
        )
        # A bare target over an associative array is the key "0".
        assert await assign_element(session, "m", None, "top") == "ok"
        assert await assign_element(session, "m", "", "v") == "subscript"

    asyncio.run(run())
    assert session.assocs["m"]["b"] == "2x"
    assert session.assocs["m"]["0"] == "top"


def test_assign_element_indexed_scalar_and_statuses():
    session = _element_session()
    held = session.vars.pop("s5")
    session.vars["ro"] = ShellVar(held.value, held.attrs | {VarAttr.READONLY})
    session.visibility = Visibility(vars=HiddenVars(names=("h",)))

    async def run():
        assert await assign_element(session, "arr", "1", "X") == "ok"
        assert await assign_element(session, "arr", "-1", "Y") == "ok"
        assert await assign_element(session, "arr", "-9", "n") == "subscript"
        # An existing scalar migrates to element 0 under a subscript.
        seed_var(session, "sc", "base")
        assert await assign_element(session, "sc", "1", "one") == "ok"
        assert await assign_element(session, "ro", "0", "x") == "readonly"
        assert await assign_element(session, "h", "0", "x") == "denied"

    asyncio.run(run())
    assert session.arrays["arr"] == make_array(["10", "X", "Y"])
    assert session.arrays["sc"] == make_array(["base", "one"])


def test_views_list_only_what_a_lookup_finds():
    session = _element_session()
    seed_var(session, "SECRET", "k")
    session.visibility = Visibility(vars=HiddenVars(names=("SECRET",)))
    env = visible_env(session)
    assert "SECRET" not in env and "SECRET" not in list(env)
    assert set(env) <= set(session.env)
    assert list(visible_arrays(session)) == ["arr"]
    assert list(visible_assocs(session)) == ["m"]
    session.pipe_status = (3,)
    assert visible_arrays(session)["PIPESTATUS"] == make_array(["3"])
    assert "PIPESTATUS" not in list(visible_arrays(session))


def test_subscript_index_lands_its_assignments_and_seeds_random():
    session = SessionState(session_id="s", cwd="/")
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
        assert session.vars.shell.next_random() == 26794
        # A hidden name the subscript assigns refuses.
        session.visibility = Visibility(
            vars=HiddenVars(patterns=("SECRET_*",))
        )
        with pytest.raises(PolicyDenied):
            await subscript_index(session, "SECRET_N=1")
        assert "SECRET_N" not in session.env

    asyncio.run(run())


def _managed(value: str | None) -> ShellVar:
    return ShellVar(
        value,
        frozenset({VarAttr.EXPORT}),
        managed=ManagedRef("env", "", "TOKEN", False),
    )


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
    session = SessionState(session_id="s", cwd="/")
    session.vars["RANDOM"] = ShellVar("1")
    set_attr(session, "n", VarAttr.INTEGER)
    seed_var(session, "x", "y=5,1/0")

    async def run():
        with pytest.raises(ArithError):
            await set_var(session, "n", "x")
        assert session.vars["y"].value == "5"
        assert "n" not in session.env
        seed_var(session, "x", "RANDOM=42,1/0")
        with pytest.raises(ArithError):
            await set_var(session, "n", "x")
        assert session.vars.shell.next_random() == 17772

    asyncio.run(run())


def test_positional_params_are_a_functions_own_even_when_empty():
    session = SessionState(session_id="s", positional_args=["a", "b"])
    stack = CallStack()
    assert positional_params(session, stack) == ["a", "b"]
    stack.push([])
    assert positional_params(session, stack) == []
    set_positional_params(session, stack, ["x"])
    assert stack.get_all_positional() == ["x"]
    assert session.positional_args == ["a", "b"]
    stack.pop()
    set_positional_params(session, stack, ["y"])
    assert session.positional_args == ["y"]


@pytest.mark.asyncio
async def test_unset_reveals_what_an_enclosing_scope_saved():
    view, session = _view()
    shell = session.vars.shell
    seed_var(session, "A", "old")
    temp = shell.open_temp()
    shell.save_temp(temp, "A")
    seed_var(session, "A", "pre")
    outer = shell.enter()
    await view.unset("A")
    assert session.env["A"] == "old"
    shell.leave(outer)
    shell.close_temp(temp)
    assert session.env["A"] == "old"


@pytest.mark.asyncio
async def test_unset_of_a_local_leaves_it_unset():
    view, session = _view()
    shell = session.vars.shell
    seed_var(session, "A", "1")
    outer = shell.enter()
    shell.shadow("A", False)
    seed_var(session, "A", "local")
    await view.unset("A")
    assert "A" not in session.env
    shell.leave(outer)
    assert session.env["A"] == "1"


def test_outlive_call_keeps_a_temporary_environment_name():
    session = SessionState(session_id="s")
    shell = session.vars.shell
    temp = shell.open_temp()
    shell.save_temp(temp, "A")
    seed_var(session, "A", "t")
    outer = shell.enter()
    assert in_call_env(session, "A")
    outlive_call(session, "A")
    assert not in_call_env(session, "A")
    shell.leave(outer)
    shell.close_temp(temp)
    assert session.env["A"] == "t"


@pytest.mark.asyncio
async def test_a_frame_voices_its_own_session_while_another_runs():
    _, session = _view()
    _, other = _view()
    held = parse_program("true\necho here")
    session._line_node = held.root.named_children[1]
    gone = parse_program("echo there")
    other._line_node = gone.root.named_children[0]
    gone.release()
    set_attr(session, "r", VarAttr.NAMEREF)
    notes: list[str | bytes] = []
    token = set_current_session(other)
    try:
        await set_var(session, "r", make_array(["x"]), diagnostics=notes)
    finally:
        reset_caller(token)
    held.release()
    assert [
        note if isinstance(note, str) else note.decode() for note in notes
    ] == ["bash: line 2: warning: r: removing nameref attribute\n"]
