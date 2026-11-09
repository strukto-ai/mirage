import pytest

from mirage.shell.array import ShellArray, make_array
from mirage.shell.variable import VarAttr
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.unset import handle_unset
from mirage.workspace.session.functions import FunctionSite
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import seed_var, set_attr


def make_session() -> SessionState:
    return SessionState(session_id="s1")


async def no_lines(*args, **kwargs):
    raise AssertionError("no nested line runs here")


async def unset(args: list[str], session: SessionState):
    return await handle_unset(args, EvaluationContext(session), no_lines)


@pytest.mark.asyncio
async def test_unset_f_removes_function_only():
    session = make_session()
    session.functions["fn"] = "fn() { :; }"
    session._function_sites["fn"] = FunctionSite("fn() { :; }", (1, 0), None)
    seed_var(session, "fn", "keepvar")
    await unset(["-f", "fn"], session)
    assert "fn" not in session.functions
    assert "fn" not in session._function_sites
    assert session.env["fn"] == "keepvar"


@pytest.mark.asyncio
async def test_unset_v_removes_variable_not_function():
    session = make_session()
    session.functions["fn"] = "fn() { :; }"
    seed_var(session, "fn", "v")
    await unset(["-v", "fn"], session)
    assert "fn" in session.functions
    assert "fn" not in session.env


@pytest.mark.asyncio
async def test_unset_bare_prefers_variable_then_function():
    session = make_session()
    session.functions["a"] = "a() { :; }"
    seed_var(session, "a", "v")
    await unset(["a"], session)
    # The variable existed, so only it is removed.
    assert "a" not in session.env
    assert "a" in session.functions
    # No variable of this name: the function is removed instead.
    session.functions["b"] = "b() { :; }"
    session._function_sites["b"] = FunctionSite("b() { :; }", (1, 0), None)
    await unset(["b"], session)
    assert "b" not in session.functions
    assert "b" not in session._function_sites


@pytest.mark.asyncio
async def test_unset_removes_whole_array_and_one_element():
    session = make_session()
    seed_var(session, "arr", make_array(["x", "y", "z"]))
    # An interior element leaves a hole: the later indices keep their
    # positions, as bash does.
    await unset(["arr[1]"], session)
    assert session.arrays["arr"] == ShellArray({0: "x", 2: "z"})
    # A trailing element drops off, so the extent shrinks with it.
    await unset(["arr[2]"], session)
    assert session.arrays["arr"] == make_array(["x"])
    await unset(["arr"], session)
    assert "arr" not in session.arrays


@pytest.mark.asyncio
async def test_unset_readonly_array_element_is_rejected():
    session = make_session()
    seed_var(session, "arr", make_array(["x", "y"]))
    set_attr(session, "arr", VarAttr.READONLY)
    _, io, node = await unset(["arr[1]"], session)
    assert node.exit_code == 1
    assert (
        io.stderr
        == b"bash: line 1: unset: arr: cannot unset: readonly variable\n"
    )
    assert session.arrays["arr"] == make_array(["x", "y"])


@pytest.mark.asyncio
async def test_unset_element_zero_of_a_scalar_removes_it():
    session = make_session()
    seed_var(session, "Y", "sc")
    _, io, node = await unset(["Y[0]"], session)
    assert node.exit_code == 0
    assert "Y" not in session.env


@pytest.mark.asyncio
async def test_unset_nonzero_element_of_a_scalar_errors():
    session = make_session()
    seed_var(session, "Y", "sc")
    _, io, node = await unset(["Y[1]"], session)
    assert node.exit_code == 1
    assert io.stderr == b"bash: line 1: unset: Y: not an array variable\n"
    assert session.env["Y"] == "sc"


@pytest.mark.asyncio
async def test_unset_negative_element_outside_the_extent_errors():
    session = make_session()
    seed_var(session, "arr", make_array(["x"]))
    _, io, node = await unset(["arr[-2]"], session)
    assert node.exit_code == 1
    # bash prints only the bracketed part here, not the base name.
    assert io.stderr == b"bash: line 1: unset: [-2]: bad array subscript\n"
    assert session.arrays["arr"] == make_array(["x"])


@pytest.mark.asyncio
async def test_unset_negative_element_inside_the_extent_works():
    session = make_session()
    seed_var(session, "arr", make_array(["x", "y"]))
    _, io, node = await unset(["arr[-2]"], session)
    assert node.exit_code == 0
    assert session.arrays["arr"] == ShellArray({1: "y"})


@pytest.mark.asyncio
async def test_unset_element_of_an_unset_name_is_a_no_op():
    session = make_session()
    _, io, node = await unset(["GONE[3]"], session)
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_unset_invalid_option_errors():
    session = make_session()
    _, io, node = await unset(["-z", "x"], session)
    assert node.exit_code == 2
    assert b"invalid option" in (io.stderr or b"")
