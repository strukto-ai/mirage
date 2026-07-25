from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.workspace.executor.builtins.vars import (  # yapf: disable
    handle_env, handle_exit, handle_getopts, handle_read, handle_return,
    handle_shift, handle_whoami)
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session.session import Session


def make_session() -> Session:
    return Session(session_id="s1")


def _unused_execute_fn():
    raise AssertionError("execute_fn should not be called")


@pytest.mark.asyncio
async def test_env_prints_environment_in_insertion_order():
    session = make_session()
    session.env["ZZZ"] = "1"
    session.env["AAA"] = "2"
    out, io, _ = await handle_env(_unused_execute_fn, [], session)
    assert io.exit_code == 0
    assert await materialize(out) == b"ZZZ=1\nAAA=2\n"


@pytest.mark.asyncio
async def test_env_ignore_environment_and_null_terminator():
    session = make_session()
    session.env["KEEP"] = "x"
    out, _, _ = await handle_env(_unused_execute_fn,
                                 ["-i", "-0", "A=1", "B=2"], session)
    assert await materialize(out) == b"A=1\x00B=2\x00"


@pytest.mark.asyncio
async def test_env_unset_removes_variable():
    session = make_session()
    session.env["DROP"] = "1"
    session.env["KEEP"] = "2"
    out, _, _ = await handle_env(_unused_execute_fn, ["-u", "DROP"], session)
    rendered = await materialize(out)
    assert b"DROP=" not in rendered
    assert b"KEEP=2" in rendered


@pytest.mark.asyncio
async def test_env_run_form_forwards_stdin_and_restores_env():
    session = make_session()
    session.env["FOO"] = "original"
    execute_fn = AsyncMock(return_value=IOResult(exit_code=0))
    await handle_env(execute_fn, ["-i", "FOO=temp", "printenv", "FOO"],
                     session,
                     stdin=b"piped\n")
    execute_fn.assert_awaited_once()
    args, kwargs = execute_fn.call_args
    assert args[0] == "printenv FOO"
    assert kwargs["stdin"] == b"piped\n"
    # The session environment is restored after the inner command runs.
    assert session.env == {"FOO": "original"}


@pytest.mark.asyncio
async def test_env_lone_dash_implies_ignore_environment():
    session = make_session()
    session.env["KEEP"] = "x"
    out, io, _ = await handle_env(_unused_execute_fn, ["-", "A=1"], session)
    assert io.exit_code == 0
    assert await materialize(out) == b"A=1\n"


@pytest.mark.asyncio
async def test_env_null_with_command_rejected():
    _, io, _ = await handle_env(_unused_execute_fn, ["-0", "echo", "hi"],
                                make_session())
    assert io.exit_code == 125
    assert await materialize(
        io.stderr) == (b"env: cannot specify --null (-0) with command\n"
                       b"Try 'env --help' for more information.\n")


@pytest.mark.asyncio
async def test_env_invalid_option_exits_125():
    _, io, _ = await handle_env(_unused_execute_fn, ["-Z"], make_session())
    assert io.exit_code == 125
    assert await materialize(io.stderr
                             ) == (b"env: invalid option -- 'Z'\n"
                                   b"Try 'env --help' for more information.\n")


@pytest.mark.asyncio
async def test_env_unrecognized_long_option_exits_125():
    _, io, _ = await handle_env(_unused_execute_fn, ["--bogus"],
                                make_session())
    assert io.exit_code == 125
    assert await materialize(io.stderr
                             ) == (b"env: unrecognized option '--bogus'\n"
                                   b"Try 'env --help' for more information.\n")


@pytest.mark.asyncio
async def test_shift_non_numeric_errors_like_bash():
    _, io, _ = await handle_shift(["x"], None, session=make_session())
    assert io.exit_code == 1
    assert (await
            materialize(io.stderr)) == b"shift: x: numeric argument required\n"


@pytest.mark.asyncio
async def test_shift_too_many_arguments():
    _, io, _ = await handle_shift(["1", "2"], None, session=make_session())
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b"shift: too many arguments\n"


@pytest.mark.asyncio
async def test_shift_default_one():
    session = make_session()
    session.positional_args = ["a", "b"]
    _, io, _ = await handle_shift([], None, session=session)
    assert io.exit_code == 0
    assert session.positional_args == ["b"]


def make_function_stack() -> CallStack:
    cs = CallStack()
    cs.push([], function_name="f")
    return cs


@pytest.mark.asyncio
async def test_return_non_numeric_raises_2_with_message():
    with pytest.raises(ReturnSignal) as exc:
        await handle_return(["x"], make_session(), make_function_stack())
    assert exc.value.exit_code == 2
    assert exc.value.stderr == b"return: x: numeric argument required\n"


@pytest.mark.asyncio
async def test_return_numeric():
    with pytest.raises(ReturnSignal) as exc:
        await handle_return(["7"], make_session(), make_function_stack())
    assert exc.value.exit_code == 7
    assert exc.value.stderr == b""


@pytest.mark.asyncio
async def test_return_bare_propagates_last_exit_code():
    session = make_session()
    session.last_exit_code = 1
    with pytest.raises(ReturnSignal) as exc:
        await handle_return([], session, make_function_stack())
    assert exc.value.exit_code == 1


@pytest.mark.asyncio
async def test_return_outside_function_fails_without_signal():
    _, io, _ = await handle_return([], make_session(), CallStack())
    assert io.exit_code == 2
    assert b"can only `return'" in io.stderr


@pytest.mark.asyncio
async def test_return_in_source_raises_signal():
    session = make_session()
    session.source_depth = 1
    session.last_exit_code = 0
    with pytest.raises(ReturnSignal) as exc:
        await handle_return([], session, None)
    assert exc.value.exit_code == 0


@pytest.mark.asyncio
async def test_return_too_many_args_fails_without_signal():
    _, io, _ = await handle_return(["1", "2"], make_session(),
                                   make_function_stack())
    assert io.exit_code == 1
    assert io.stderr == b"return: too many arguments\n"


@pytest.mark.asyncio
async def test_exit_numeric_raises_signal():
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["3"], make_session())
    assert exc.value.exit_code == 3
    assert exc.value.contained_code == 3


@pytest.mark.asyncio
async def test_exit_no_arg_uses_last_exit_code():
    session = make_session()
    session.last_exit_code = 5
    with pytest.raises(ExitSignal) as exc:
        await handle_exit([], session)
    assert exc.value.exit_code == 5


@pytest.mark.asyncio
async def test_exit_wraps_status_mod_256():
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["300"], make_session())
    assert exc.value.exit_code == 44
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["-1"], make_session())
    assert exc.value.exit_code == 255


@pytest.mark.asyncio
async def test_exit_non_numeric_exits_2_with_message():
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["abc"], make_session())
    assert exc.value.exit_code == 2
    assert exc.value.stderr == b"exit: abc: numeric argument required\n"


@pytest.mark.asyncio
async def test_exit_too_many_arguments_does_not_exit():
    _, io, _ = await handle_exit(["1", "2"], make_session())
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b"exit: too many arguments\n"


@pytest.mark.asyncio
async def test_read_invalid_option_exits_2():
    _, io, _ = await handle_read(["-q", "v"], make_session(), b"line\n")
    assert io.exit_code == 2
    assert await materialize(io.stderr) == b"read: -q: invalid option\n"


@pytest.mark.asyncio
async def test_read_dash_r_consumed_not_a_variable():
    session = make_session()
    _, io, _ = await handle_read(["-r", "v"], session, b"hello world\n")
    assert io.exit_code == 0
    assert session.env["v"] == "hello world"
    assert "-r" not in session.env


@pytest.mark.asyncio
async def test_read_defaults_to_reply():
    session = make_session()
    _, io, _ = await handle_read([], session, b"hi\n")
    assert io.exit_code == 0
    assert session.env["REPLY"] == "hi"


@pytest.mark.asyncio
async def test_whoami_prints_workspace_user():
    out, io, node = await handle_whoami(Namespace(MagicMock(), user="alice"))
    assert io.exit_code == 0
    assert out == b"alice\n"
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_whoami_errors_without_identity():
    out, io, _ = await handle_whoami(Namespace(MagicMock()))
    assert io.exit_code == 1
    assert out is None
    assert io.stderr == b"whoami: cannot find name for user ID\n"


async def _read_ws() -> Workspace:
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /data")
    return ws


@pytest.mark.asyncio
async def test_read_replaces_stale_stdin_buffer():
    # A previous read's exhausted herestring buffer must not shadow a
    # new command's stdin.
    ws = await _read_ws()
    await ws.execute("read -r x <<< first")
    io = await ws.execute('read -r y <<< second\necho "y=$y"')
    assert (io.stdout or b"") == b"y=second\n"


@pytest.mark.asyncio
async def test_read_scalar_replaces_array():
    ws = await _read_ws()
    await ws.execute("a=(x y z)")
    io = await ws.execute('read -r a b <<< "one two"\necho "a=$a b=$b"')
    assert (io.stdout or b"") == b"a=one b=two\n"


@pytest.mark.asyncio
async def test_getopts_single_flag_sets_var_and_advances_optind():
    session = make_session()
    _, io, _ = await handle_getopts(["ab", "o", "-a"], session)
    assert io.exit_code == 0
    assert session.env["o"] == "a"
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_iterates_two_flags_then_stops():
    session = make_session()
    args = ["ab", "o", "-a", "-b"]
    _, io1, _ = await handle_getopts(args, session)
    assert (io1.exit_code, session.env["o"], session.env["OPTIND"]) == (0, "a",
                                                                        "2")
    _, io2, _ = await handle_getopts(args, session)
    assert (io2.exit_code, session.env["o"], session.env["OPTIND"]) == (0, "b",
                                                                        "3")
    _, io3, _ = await handle_getopts(args, session)
    assert io3.exit_code == 1
    assert session.env["o"] == "?"


@pytest.mark.asyncio
async def test_getopts_separate_optarg():
    session = make_session()
    _, io, _ = await handle_getopts(["a:b", "o", "-a", "foo", "-b"], session)
    assert io.exit_code == 0
    assert session.env["o"] == "a"
    assert session.env["OPTARG"] == "foo"
    assert session.env["OPTIND"] == "3"


@pytest.mark.asyncio
async def test_getopts_attached_optarg():
    session = make_session()
    _, io, _ = await handle_getopts(["a:", "o", "-afoo"], session)
    assert io.exit_code == 0
    assert session.env["o"] == "a"
    assert session.env["OPTARG"] == "foo"
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_combined_flags_share_optind_until_word_done():
    session = make_session()
    args = ["abc", "o", "-abc"]
    _, _, _ = await handle_getopts(args, session)
    assert (session.env["o"], session.env["OPTIND"]) == ("a", "1")
    _, _, _ = await handle_getopts(args, session)
    assert (session.env["o"], session.env["OPTIND"]) == ("b", "1")
    _, _, _ = await handle_getopts(args, session)
    assert (session.env["o"], session.env["OPTIND"]) == ("c", "2")


@pytest.mark.asyncio
async def test_getopts_invalid_option_non_silent():
    session = make_session()
    _, io, _ = await handle_getopts(["ab", "o", "-x"], session)
    assert io.exit_code == 0
    assert session.env["o"] == "?"
    assert await materialize(io.stderr) == b"bash: illegal option -- x\n"
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_invalid_option_silent_sets_optarg_no_stderr():
    session = make_session()
    _, io, _ = await handle_getopts([":ab", "o", "-x"], session)
    assert io.exit_code == 0
    assert session.env["o"] == "?"
    assert session.env["OPTARG"] == "x"
    assert await materialize(io.stderr) == b""


@pytest.mark.asyncio
async def test_getopts_missing_arg_non_silent():
    session = make_session()
    _, io, _ = await handle_getopts(["a:", "o", "-a"], session)
    assert io.exit_code == 0
    assert session.env["o"] == "?"
    assert (await materialize(io.stderr
                              )) == b"bash: option requires an argument -- a\n"


@pytest.mark.asyncio
async def test_getopts_missing_arg_silent_sets_colon_and_optarg():
    session = make_session()
    _, io, _ = await handle_getopts([":a:", "o", "-a"], session)
    assert io.exit_code == 0
    assert session.env["o"] == ":"
    assert session.env["OPTARG"] == "a"
    assert await materialize(io.stderr) == b""


@pytest.mark.asyncio
async def test_getopts_nonoption_stops_without_advancing():
    session = make_session()
    _, io, _ = await handle_getopts(["ab", "o", "foo", "-a"], session)
    assert io.exit_code == 1
    assert session.env["OPTIND"] == "1"


@pytest.mark.asyncio
async def test_getopts_double_dash_consumed_then_stops():
    session = make_session()
    _, io, _ = await handle_getopts(["ab", "o", "--", "-a"], session)
    assert io.exit_code == 1
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_no_args_stops():
    session = make_session()
    _, io, _ = await handle_getopts(["ab", "o"], session)
    assert io.exit_code == 1
    assert session.env["OPTIND"] == "1"


@pytest.mark.asyncio
async def test_getopts_reads_positional_args_when_no_explicit():
    session = make_session()
    session.positional_args = ["-a", "-b"]
    _, io, _ = await handle_getopts(["ab", "o"], session)
    assert io.exit_code == 0
    assert session.env["o"] == "a"


@pytest.mark.asyncio
async def test_getopts_usage_error_too_few_operands():
    session = make_session()
    _, io, _ = await handle_getopts(["ab"], session)
    assert io.exit_code == 2
    assert (await
            materialize(io.stderr
                        )) == b"getopts: usage: getopts optstring name [arg]\n"


@pytest.mark.asyncio
async def test_getopts_optind_reset_reparses():
    session = make_session()
    session.positional_args = ["-a", "-b"]
    await handle_getopts(["ab", "o"], session)
    await handle_getopts(["ab", "o"], session)
    _, stop, _ = await handle_getopts(["ab", "o"], session)
    assert stop.exit_code == 1
    session.env["OPTIND"] = "1"
    session.positional_args = ["-b", "-a"]
    _, io, _ = await handle_getopts(["ab", "o"], session)
    assert io.exit_code == 0
    assert session.env["o"] == "b"


@pytest.mark.asyncio
async def test_getopts_end_to_end_loop_with_case():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute('set -- -a val -b\n'
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
    await handle_getopts(["ab", "o", "-ab"], session)
    _, io, _ = await handle_getopts(["ab", "o", "-a"], session)
    assert io.exit_code == 0
    assert session.env["o"] == "a"
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_nonpositive_optind_restarts_at_one():
    session = make_session()
    session.positional_args = ["-a", "-b"]
    session.env["OPTIND"] = "0"
    _, io, _ = await handle_getopts(["ab", "o"], session)
    assert io.exit_code == 0
    assert session.env["o"] == "a"
    assert session.env["OPTIND"] == "2"


@pytest.mark.asyncio
async def test_getopts_invalid_identifier_destination():
    session = make_session()
    _, io, _ = await handle_getopts(["a", "bad-name", "-a"], session)
    assert io.exit_code == 1
    assert b"not a valid identifier" in (await materialize(io.stderr))
    assert "bad-name" not in session.env


@pytest.mark.asyncio
async def test_getopts_readonly_destination_is_not_overwritten():
    session = make_session()
    session.env["o"] = "orig"
    session.readonly_vars.add("o")
    _, io, _ = await handle_getopts(["a", "o", "-a"], session)
    assert io.exit_code == 1
    assert session.env["o"] == "orig"
    assert b"readonly variable" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_getopts_opterr_zero_suppresses_stderr():
    session = make_session()
    session.env["OPTERR"] = "0"
    _, io, _ = await handle_getopts(["ab", "o", "-x"], session)
    assert session.env["o"] == "?"
    assert (await materialize(io.stderr)) == b""


@pytest.mark.asyncio
async def test_getopts_scans_function_frame_positional():
    session = make_session()
    cs = CallStack()
    cs.push(["-a", "-b"], function_name="f")
    await handle_getopts(["ab", "o"], session, cs)
    assert session.env["o"] == "a"
    await handle_getopts(["ab", "o"], session, cs)
    assert session.env["o"] == "b"


@pytest.mark.asyncio
async def test_getopts_fork_preserves_cursor():
    session = make_session()
    await handle_getopts(["ab", "o", "-ab"], session)
    forked = session.fork()
    assert forked._getopts_pos == session._getopts_pos
    assert forked._getopts_optind == session._getopts_optind


@pytest.mark.asyncio
async def test_getopts_reassign_optind_same_value_reparses():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute('set -- -ab; getopts ab o; echo "1:$o"; '
                          'OPTIND=1; getopts ab o; echo "2:$o"')
    assert (io.stdout or b"") == b"1:a\n2:a\n"


@pytest.mark.asyncio
async def test_getopts_subshell_does_not_corrupt_parent_cursor():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute('set -- -ab; OPTIND=1; getopts ab o; '
                          '(getopts ab o); getopts ab o; echo "$o"')
    assert (io.stdout or b"") == b"b\n"
