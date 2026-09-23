import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io.stream import materialize
from mirage.shell.call_stack import CallStack
from mirage.shell.variable import VarAttr
from mirage.workspace.executor.builtins.getopts import handle_getopts
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import seed_var, session_view, set_attr


def make_session() -> SessionState:
    return SessionState(session_id="s1")


@pytest.mark.asyncio
async def test_getopts_single_flag_sets_var_and_advances_optind():
    session = make_session()
    _, io, _ = await handle_getopts(["ab", "o", "-a"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == "a"
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_iterates_two_flags_then_stops():
    session = make_session()
    args = ["ab", "o", "-a", "-b"]
    _, io1, _ = await handle_getopts(args,
                                     session,
                                     state=session_view(session))
    assert (io1.exit_code, session.env["o"], session.env["OPTIND"]) == (0, "a",
                                                                        "2")
    _, io2, _ = await handle_getopts(args,
                                     session,
                                     state=session_view(session))
    assert (io2.exit_code, session.env["o"], session.env["OPTIND"]) == (0, "b",
                                                                        "3")
    _, io3, _ = await handle_getopts(args,
                                     session,
                                     state=session_view(session))
    assert io3.exit_code == 1
    assert session.env["o"] == "?"


@pytest.mark.asyncio
async def test_getopts_separate_optarg():
    session = make_session()
    _, io, _ = await handle_getopts(["a:b", "o", "-a", "foo", "-b"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == "a"
    assert session.env["OPTARG"] == "foo"
    assert session.env["OPTIND"] == "3"


@pytest.mark.asyncio
async def test_getopts_attached_optarg():
    session = make_session()
    _, io, _ = await handle_getopts(["a:", "o", "-afoo"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == "a"
    assert session.env["OPTARG"] == "foo"
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_combined_flags_share_optind_until_word_done():
    session = make_session()
    args = ["abc", "o", "-abc"]
    _, _, _ = await handle_getopts(args, session, state=session_view(session))
    assert (session.env["o"], session.env["OPTIND"]) == ("a", "1")
    _, _, _ = await handle_getopts(args, session, state=session_view(session))
    assert (session.env["o"], session.env["OPTIND"]) == ("b", "1")
    _, _, _ = await handle_getopts(args, session, state=session_view(session))
    assert (session.env["o"], session.env["OPTIND"]) == ("c", "2")


@pytest.mark.asyncio
async def test_getopts_invalid_option_non_silent():
    session = make_session()
    _, io, _ = await handle_getopts(["ab", "o", "-x"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == "?"
    assert await materialize(io.stderr) == b"bash: illegal option -- x\n"
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_invalid_option_silent_sets_optarg_no_stderr():
    session = make_session()
    _, io, _ = await handle_getopts([":ab", "o", "-x"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == "?"
    assert session.env["OPTARG"] == "x"
    assert await materialize(io.stderr) == b""


@pytest.mark.asyncio
async def test_getopts_missing_arg_non_silent():
    session = make_session()
    _, io, _ = await handle_getopts(["a:", "o", "-a"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == "?"
    assert (await materialize(io.stderr
                              )) == b"bash: option requires an argument -- a\n"


@pytest.mark.asyncio
async def test_getopts_missing_arg_silent_sets_colon_and_optarg():
    session = make_session()
    _, io, _ = await handle_getopts([":a:", "o", "-a"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == ":"
    assert session.env["OPTARG"] == "a"
    assert await materialize(io.stderr) == b""


@pytest.mark.asyncio
async def test_getopts_nonoption_stops_without_advancing():
    session = make_session()
    _, io, _ = await handle_getopts(["ab", "o", "foo", "-a"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 1
    assert session.env["OPTIND"] == "1"


@pytest.mark.asyncio
async def test_getopts_double_dash_consumed_then_stops():
    session = make_session()
    _, io, _ = await handle_getopts(["ab", "o", "--", "-a"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 1
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_no_args_stops():
    session = make_session()
    _, io, _ = await handle_getopts(["ab", "o"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 1
    assert session.env["OPTIND"] == "1"


@pytest.mark.asyncio
async def test_getopts_reads_positional_args_when_no_explicit():
    session = make_session()
    session.positional_args = ["-a", "-b"]
    _, io, _ = await handle_getopts(["ab", "o"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == "a"


@pytest.mark.asyncio
async def test_getopts_usage_error_too_few_operands():
    session = make_session()
    _, io, _ = await handle_getopts(["ab"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 2
    assert (await
            materialize(io.stderr
                        )) == b"getopts: usage: getopts optstring name [arg]\n"


@pytest.mark.asyncio
async def test_getopts_optind_reset_reparses():
    session = make_session()
    session.positional_args = ["-a", "-b"]
    await handle_getopts(["ab", "o"], session, state=session_view(session))
    await handle_getopts(["ab", "o"], session, state=session_view(session))
    _, stop, _ = await handle_getopts(["ab", "o"],
                                      session,
                                      state=session_view(session))
    assert stop.exit_code == 1
    seed_var(session, "OPTIND", "1")
    session.positional_args = ["-b", "-a"]
    _, io, _ = await handle_getopts(["ab", "o"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == "b"


@pytest.mark.asyncio
async def test_getopts_end_to_end_loop_with_case():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell('set -- -a val -b\n'
                        'while getopts "a:b" opt; do\n'
                        '  case $opt in\n'
                        '    a) echo "a=$OPTARG" ;;\n'
                        '    b) echo "b-set" ;;\n'
                        '  esac\n'
                        'done')
    assert (io.stdout or b"") == b"a=val\nb-set\n"


@pytest.mark.asyncio
async def test_getopts_stale_offset_shorter_word_no_crash():
    session = make_session()
    await handle_getopts(["ab", "o", "-ab"],
                         session,
                         state=session_view(session))
    _, io, _ = await handle_getopts(["ab", "o", "-a"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == "a"
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_nonpositive_optind_restarts_at_one():
    session = make_session()
    session.positional_args = ["-a", "-b"]
    seed_var(session, "OPTIND", "0")
    _, io, _ = await handle_getopts(["ab", "o"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 0
    assert session.env["o"] == "a"
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_invalid_identifier_destination():
    session = make_session()
    _, io, _ = await handle_getopts(["a", "bad-name", "-a"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 1
    assert b"not a valid identifier" in (await materialize(io.stderr))
    assert "bad-name" not in session.env


@pytest.mark.asyncio
async def test_getopts_readonly_destination_is_not_overwritten():
    session = make_session()
    seed_var(session, "o", "orig")
    set_attr(session, "o", VarAttr.READONLY)
    _, io, _ = await handle_getopts(["a", "o", "-a"],
                                    session,
                                    state=session_view(session))
    assert io.exit_code == 1
    assert session.env["o"] == "orig"
    assert b"readonly variable" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_getopts_opterr_zero_suppresses_stderr():
    session = make_session()
    seed_var(session, "OPTERR", "0")
    _, io, _ = await handle_getopts(["ab", "o", "-x"],
                                    session,
                                    state=session_view(session))
    assert session.env["o"] == "?"
    assert (await materialize(io.stderr)) == b""


@pytest.mark.asyncio
async def test_getopts_scans_function_frame_positional():
    session = make_session()
    cs = CallStack()
    cs.push(["-a", "-b"], function_name="f")
    await handle_getopts(["ab", "o"], session, cs, state=session_view(session))
    assert session.env["o"] == "a"
    await handle_getopts(["ab", "o"], session, cs, state=session_view(session))
    assert session.env["o"] == "b"


@pytest.mark.asyncio
async def test_getopts_fork_preserves_cursor():
    session = make_session()
    await handle_getopts(["ab", "o", "-ab"],
                         session,
                         state=session_view(session))
    forked = session.fork()
    assert forked._getopts_pos == session._getopts_pos
    assert forked._getopts_optind == session._getopts_optind


@pytest.mark.asyncio
async def test_getopts_reassign_optind_same_value_reparses():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell('set -- -ab; getopts ab o; echo "1:$o"; '
                        'OPTIND=1; getopts ab o; echo "2:$o"')
    assert (io.stdout or b"") == b"1:a\n2:a\n"


@pytest.mark.asyncio
async def test_getopts_subshell_does_not_corrupt_parent_cursor():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell('set -- -ab; OPTIND=1; getopts ab o; '
                        '(getopts ab o); getopts ab o; echo "$o"')
    assert (io.stdout or b"") == b"b\n"
