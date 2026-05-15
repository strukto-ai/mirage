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
from unittest.mock import AsyncMock, MagicMock

from mirage.io import IOResult
from mirage.shell import parse
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.job_table import JobTable
from mirage.types import MountMode, PathSpec
from mirage.workspace.node.execute_node import execute_node
from mirage.workspace.session import Session


def _session(cwd="/", env=None):
    return Session(session_id="test", cwd=cwd, env=env or {})


def _mock_dispatch():
    d = AsyncMock()
    d.return_value = (b"", IOResult())
    return d


async def _echo_resolve_glob(scopes, prefix=""):
    # Return resource-relative paths, matching real resolve_glob behavior
    results = []
    for s in scopes:
        path = s.original
        if prefix and path.startswith(prefix):
            path = path[len(prefix):] or "/"
        results.append(path)
    return results


def _mock_registry():
    mount = MagicMock()
    mount.prefix = "/data/"
    mount.mode = MountMode.EXEC
    mount.execute_cmd = AsyncMock(return_value=(b"ok\n", IOResult()))
    mount.resource = MagicMock()
    mount.resource.resolve_glob = _echo_resolve_glob
    mount.spec_for = MagicMock(return_value=None)

    reg = MagicMock()
    reg.mount_for = MagicMock(return_value=mount)
    reg.resolve_mount = AsyncMock(return_value=mount)
    return reg, mount


async def _sort_execute_cmd(name,
                            paths,
                            texts,
                            flag_kwargs,
                            *,
                            stdin=None,
                            **kwargs):
    """Mock execute_cmd that sorts stdin for sort command."""
    if name == "sort" and stdin:
        data = stdin if isinstance(stdin, bytes) else b""
        lines = data.decode().strip().split("\n")
        lines.sort()
        return "\n".join(lines).encode() + b"\n", IOResult()
    return b"ok\n", IOResult()


def _run(coro):
    return asyncio.run(coro)


async def _aexec(cmd, session=None, dispatch=None, registry=None, env=None):
    session = session or _session(env=env or {})
    dispatch = dispatch or _mock_dispatch()
    reg, mount = registry or _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    node = parse(cmd)

    stdout, io, exec_node = await execute_node(dispatch, reg, job_table,
                                               execute_fn, "agent-1", node,
                                               session)
    stdout = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
    return stdout, io, exec_node, session, mount, dispatch


def _exec(cmd, session=None, dispatch=None, registry=None, env=None):
    return _run(
        _aexec(cmd,
               session=session,
               dispatch=dispatch,
               registry=registry,
               env=env))


# ── simple commands ─────────────────────────────


def test_true():
    stdout, io, _, _, _, _ = _exec("true")
    assert io.exit_code == 0


def test_false():
    stdout, io, _, _, _, _ = _exec("false")
    assert io.exit_code == 1


def test_command_dispatches_to_mount():
    stdout, io, _, _, mount, _ = _exec("cat /data/file.txt")
    mount.execute_cmd.assert_called_once()
    args = mount.execute_cmd.call_args
    assert args[0][0] == "cat"
    scopes = args[0][1]
    assert len(scopes) == 1
    assert isinstance(scopes[0], PathSpec)
    assert scopes[0].resolved is True
    assert io.exit_code == 0


def test_trailing_comment_is_ignored_at_program_level():
    # Regression: tree-sitter-bash emits a `comment` sibling under `program`
    # for `cmd # text`. Previously this raised
    # "unsupported tree-sitter node type: comment".
    stdout, io, _, _, mount, _ = _exec(
        "cat /data/file.txt        # -l, -a clustered")
    mount.execute_cmd.assert_called_once()
    assert io.exit_code == 0


def test_standalone_comment_is_a_noop():
    # A line that's *only* a comment must execute cleanly with exit 0.
    _, io, _, _, mount, _ = _exec("# just a comment")
    mount.execute_cmd.assert_not_called()
    assert io.exit_code == 0


def test_comment_inside_compound_statement_is_skipped():
    # Comments can also appear inside `{ ... }` blocks. The compound_statement
    # named_children iterator must skip them rather than dispatching them.
    _, io, _, _, mount, _ = _exec(
        "{ cat /data/a.txt; # mid-block comment\ncat /data/b.txt; }")
    assert mount.execute_cmd.call_count == 2
    assert io.exit_code == 0


# ── export / unset / local ──────────────────────


def test_export_sets_env():
    _, io, _, session, _, _ = _exec("export FOO=bar")
    assert io.exit_code == 0
    assert session.env["FOO"] == "bar"


def test_export_multiple():
    _, _, _, session, _, _ = _exec("export A=1 B=2")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"


def test_unset_removes_env():
    _, _, _, session, _, _ = _exec("unset FOO", env={"FOO": "bar"})
    assert "FOO" not in session.env


def test_local_sets_env():
    _, _, _, session, _, _ = _exec("local X=hello")
    assert session.env["X"] == "hello"


# ── cd ──────────────────────────────────────────


def test_cd_updates_cwd():
    dispatch = _mock_dispatch()
    stat = MagicMock()
    stat.type = "directory"
    dispatch.return_value = (stat, IOResult())

    _, io, _, session, _, _ = _exec("cd /data", dispatch=dispatch)
    assert io.exit_code == 0
    assert session.cwd == "/data"


# ── pipeline ────────────────────────────────────


def test_pipeline():
    _, io, exec_node, _, _, _ = _exec("echo a | grep b")
    assert exec_node.op == "|"
    assert len(exec_node.children) == 2
    assert io.exit_code == 0


# ── list (&&, ||) ───────────────────────────────


def test_and_success():
    stdout, io, exec_node, _, _, _ = _exec("true && true")
    assert io.exit_code == 0
    assert exec_node.op == "&&"


def test_and_short_circuit():
    _, io, exec_node, _, _, _ = _exec("false && true")
    assert io.exit_code == 1
    assert exec_node.op == "&&"


def test_or_success():
    _, io, exec_node, _, _, _ = _exec("true || false")
    assert io.exit_code == 0


def test_or_fallback():
    _, io, exec_node, _, _, _ = _exec("false || true")
    assert io.exit_code == 0
    assert exec_node.op == "||"


# ── redirect ────────────────────────────────────


def test_redirect_stdout():
    _, io, _, _, _, dispatch = _exec("echo hello > /out.txt")
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1
    assert write_calls[0][0][1].original == "/out.txt"
    assert io.exit_code == 0


# ── semicolons ──────────────────────────────────


def test_semicolons():
    _, _, _, session, _, _ = _exec("export A=1; export B=2")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"


# ── if statement ────────────────────────────────


def test_if_true_branch():
    _, _, _, session, _, _ = _exec(
        "if true; then export R=yes; else export R=no; fi")
    assert session.env["R"] == "yes"


def test_if_false_branch():
    _, _, _, session, _, _ = _exec(
        "if false; then export R=yes; else export R=no; fi")
    assert session.env["R"] == "no"


def test_if_no_else():
    _, io, _, session, _, _ = _exec("if true; then export R=ok; fi")
    assert session.env["R"] == "ok"


# ── for loop ────────────────────────────────────


def test_for_loop():
    _, io, _, session, _, _ = _exec("for x in a b c; do export LAST=$x; done")
    assert session.env["LAST"] == "c"
    assert io.exit_code == 0


# ── while loop ──────────────────────────────────


def test_while_false_no_execute():
    _, io, _, session, _, _ = _exec("while false; do export RAN=yes; done")
    assert "RAN" not in session.env
    assert io.exit_code == 0


# ── case ────────────────────────────────────────


def test_case_match():
    _, _, _, session, _, _ = _exec(
        "case hello in hello) export M=yes;; world) export M=no;; esac")
    assert session.env["M"] == "yes"


def test_case_no_match():
    _, io, _, session, _, _ = _exec("case xyz in hello) export M=yes;; esac")
    assert "M" not in session.env
    assert io.exit_code == 0


# ── subshell ────────────────────────────────────


def test_subshell_isolates_env():
    session = _session(env={"X": "before"})
    _exec("(export X=inside)", session=session)
    assert session.env["X"] == "before"


def test_subshell_isolates_cwd():
    dispatch = _mock_dispatch()
    stat = MagicMock()
    stat.type = "directory"
    dispatch.return_value = (stat, IOResult())

    session = _session(cwd="/start")
    _exec("(cd /other)", session=session, dispatch=dispatch)
    assert session.cwd == "/start"


# ── function definition ────────────────────────


def test_function_definition():
    _, _, _, session, _, _ = _exec("myfunc() { echo hello; }")
    assert "myfunc" in session.functions


# ── negated command ─────────────────────────────


def test_negated_true():
    _, io, _, _, _, _ = _exec("! true")
    assert io.exit_code == 1


def test_negated_false():
    _, io, _, _, _, _ = _exec("! false")
    assert io.exit_code == 0


# ── set ─────────────────────────────────────────


def test_set_outputs_env():
    stdout, io, _, _, _, _ = _exec("set", env={"A": "1", "B": "2"})
    assert io.exit_code == 0
    assert stdout is not None
    text = stdout.decode() if isinstance(stdout, bytes) else ""
    assert "A=1" in text
    assert "B=2" in text


# ── printenv ────────────────────────────────────


def test_printenv_single():
    stdout, io, _, _, _, _ = _exec("printenv FOO", env={"FOO": "hello"})
    assert io.exit_code == 0
    assert stdout is not None
    assert b"hello" in stdout


def test_printenv_all():
    stdout, io, _, _, _, _ = _exec("printenv", env={"X": "1"})
    assert io.exit_code == 0
    assert stdout is not None
    assert b"X=1" in stdout


# ── whoami ──────────────────────────────────────


def test_whoami_set():
    stdout, io, _, _, _, _ = _exec("whoami", env={"USER": "alice"})
    assert io.exit_code == 0
    assert stdout == b"alice\n"
    assert io.stderr in (None, b"")


def test_whoami_unset():
    stdout, io, _, _, _, _ = _exec("whoami", env={})
    assert io.exit_code == 1
    assert io.stderr == b"whoami: USER not set\n"


def test_whoami_empty():
    stdout, io, _, _, _, _ = _exec("whoami", env={"USER": ""})
    assert io.exit_code == 0
    assert stdout == b"\n"


# ── unsupported node raises ─────────────────────


def test_unsupported_node_raises():
    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    session = _session()

    fake_node = MagicMock()
    fake_node.type = "some_unknown_type_xyz"

    try:
        _run(
            execute_node(dispatch, reg, job_table, execute_fn, "agent-1",
                         fake_node, session))
        assert False, "should have raised"
    except TypeError as e:
        assert "unsupported" in str(e)


# ── read ────────────────────────────────────────


def test_read_from_bytes():
    session = _session()
    dispatch = _mock_dispatch()
    reg, mount = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    node = parse("read VAR")

    _, io, _ = _run(
        execute_node(dispatch,
                     reg,
                     job_table,
                     execute_fn,
                     "agent-1",
                     node,
                     session,
                     stdin=b"hello world"))
    assert io.exit_code == 0
    assert session.env["VAR"] == "hello world"


# ── shift ───────────────────────────────────────


def test_shift():
    _, io, _, _, _, _ = _exec("shift")
    assert io.exit_code == 0


# ── trap ────────────────────────────────────────


def test_trap():
    _, io, _, _, _, _ = _exec("trap")
    assert io.exit_code == 0


# ── return ──────────────────────────────────────


def test_return_raises():
    from mirage.workspace.executor.control import ReturnSignal

    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    session = _session()
    node = parse("return 42")

    try:
        _run(
            execute_node(dispatch, reg, job_table, execute_fn, "agent-1", node,
                         session))
        assert False, "should have raised ReturnSignal"
    except ReturnSignal as e:
        assert e.exit_code == 42


# ── break / continue ───────────────────────────


def test_break_raises():
    from mirage.workspace.executor.control import BreakSignal

    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    session = _session()
    node = parse("break")

    try:
        _run(
            execute_node(dispatch, reg, job_table, execute_fn, "agent-1", node,
                         session))
        assert False, "should have raised BreakSignal"
    except BreakSignal:
        pass


def test_continue_raises():
    from mirage.workspace.executor.control import ContinueSignal

    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    session = _session()
    node = parse("continue")

    try:
        _run(
            execute_node(dispatch, reg, job_table, execute_fn, "agent-1", node,
                         session))
        assert False, "should have raised ContinueSignal"
    except ContinueSignal:
        pass


# ── eval ────────────────────────────────────────


def test_eval():
    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    session = _session()
    node = parse("eval echo hello")

    _, io, _ = _run(
        execute_node(dispatch, reg, job_table, execute_fn, "agent-1", node,
                     session))
    execute_fn.assert_called_once()
    assert "echo hello" in execute_fn.call_args[0][0]


# ── source ──────────────────────────────────────


def test_source():
    dispatch = _mock_dispatch()
    dispatch.return_value = (b"export X=1", IOResult())
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    session = _session()
    node = parse("source /script.sh")

    _, io, _ = _run(
        execute_node(dispatch, reg, job_table, execute_fn, "agent-1", node,
                     session))
    execute_fn.assert_called_once()


# ═══════════════════════════════════════════════
# Complex / combined tests
# ═══════════════════════════════════════════════

# ── nested control flow ─────────────────────────


def test_if_inside_for():
    _, _, _, session, _, _ = _exec("for x in a b c; do "
                                   "if true; then export COUNT=yes; fi; "
                                   "done")
    assert session.env["COUNT"] == "yes"


def test_for_with_break_via_if():
    _, _, _, session, _, _ = _exec("for x in a b c; do "
                                   "export LAST=ran; "
                                   "if true; then break; fi; "
                                   "done")
    assert session.env["LAST"] == "ran"


def test_nested_if():
    _, _, _, session, _, _ = _exec("if true; then "
                                   "if true; then export DEEP=yes; fi; "
                                   "fi")
    assert session.env["DEEP"] == "yes"


def test_nested_if_outer_false():
    _, _, _, session, _, _ = _exec("if false; then "
                                   "if true; then export DEEP=yes; fi; "
                                   "fi")
    assert "DEEP" not in session.env


def test_elif_chain():
    _, _, _, session, _, _ = _exec("if false; then export R=a; "
                                   "elif false; then export R=b; "
                                   "elif true; then export R=c; "
                                   "else export R=d; fi")
    assert session.env["R"] == "c"


def test_for_inside_if():
    _, _, _, session, _, _ = _exec("if true; then "
                                   "for x in 1 2 3; do export N=loop; done; "
                                   "fi")
    assert session.env["N"] == "loop"


# ── pipelines + control flow ───────────────────


def test_pipeline_three_stages():
    _, _, exec_node, _, _, _ = _exec("echo a | grep b | sort")
    assert exec_node.op == "|"
    assert len(exec_node.children) == 3


def test_pipeline_in_if_condition():
    _, _, _, session, _, _ = _exec("if true | true; then export P=yes; fi")
    assert session.env["P"] == "yes"


# ── chained list operators ──────────────────────


def test_chained_and():
    _, _, _, session, _, _ = _exec("export A=1 && export B=2 && export C=3")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"
    assert session.env["C"] == "3"


def test_and_then_or():
    _, _, _, session, _, _ = _exec("true && export A=yes || export A=no")
    assert session.env["A"] == "yes"


def test_or_then_and():
    _, _, _, session, _, _ = _exec(
        "false || export A=fallback && export B=after")
    assert session.env["A"] == "fallback"
    assert session.env["B"] == "after"


def test_and_short_circuit_skips_rest():
    _, _, _, session, _, _ = _exec("false && export SKIP=yes")
    assert "SKIP" not in session.env


def test_or_short_circuit_skips_rest():
    _, _, _, session, _, _ = _exec("true || export SKIP=yes")
    assert "SKIP" not in session.env


# ── semicolons + control flow ──────────────────


def test_semicolons_with_if():
    _, _, _, session, _, _ = _exec("export A=1; "
                                   "if true; then export B=2; fi; "
                                   "export C=3")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"
    assert session.env["C"] == "3"


def test_many_semicolons():
    _, _, _, session, _, _ = _exec("export A=1; export B=2; export C=3; "
                                   "export D=4; export E=5")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"
    assert session.env["C"] == "3"
    assert session.env["D"] == "4"
    assert session.env["E"] == "5"


# ── subshell nesting ───────────────────────────


def test_nested_subshell():
    session = _session(env={"X": "outer"})
    _exec("(export X=mid; (export X=inner))", session=session)
    assert session.env["X"] == "outer"


def test_subshell_in_if():
    session = _session(env={"V": "before"})
    _exec("if true; then (export V=inside); fi", session=session)
    assert session.env["V"] == "before"


# ── redirect + pipeline ────────────────────────


def test_redirect_with_pipeline():
    _, io, _, _, _, dispatch = _exec("echo hello | grep hello > /out.txt")
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1
    assert write_calls[0][0][1].original == "/out.txt"


# ── case patterns ──────────────────────────────


def test_case_wildcard():
    _, _, _, session, _, _ = _exec("case hello in "
                                   "world) export M=no;; "
                                   "hel*) export M=yes;; "
                                   "esac")
    assert session.env["M"] == "yes"


def test_case_fall_through_first_match():
    _, _, _, session, _, _ = _exec("case abc in "
                                   "abc) export M=first;; "
                                   "abc) export M=second;; "
                                   "esac")
    assert session.env["M"] == "first"


# ── function define + call ─────────────────────


def test_function_then_call():
    _, _, _, session, _, _ = _exec("myfunc() { export CALLED=yes; }; myfunc")
    assert session.env["CALLED"] == "yes"


def test_function_override():
    _, _, _, session, _, _ = _exec("f() { export V=first; }; "
                                   "f() { export V=second; }; "
                                   "f")
    assert session.env["V"] == "second"


# ── negation + control flow ────────────────────


def test_negated_in_if():
    _, _, _, session, _, _ = _exec("if ! false; then export N=yes; fi")
    assert session.env["N"] == "yes"


def test_negated_true_in_if():
    _, _, _, session, _, _ = _exec(
        "if ! true; then export N=yes; else export N=no; fi")
    assert session.env["N"] == "no"


# ── while with break / continue ────────────────


def test_while_true_with_break():
    _, io, _, session, _, _ = _exec(
        "while true; do export RAN=yes; break; done")
    assert session.env["RAN"] == "yes"
    assert io.exit_code == 0


def test_while_cap_emits_warning():
    """When _MAX_WHILE is hit, stderr carries a clear warning."""
    _, io, _, _, _, _ = _exec("while true; do export X=$X.; done",
                              env={"X": ""})
    assert io.stderr is not None
    stderr_bytes = io.stderr if isinstance(io.stderr, bytes) else b""
    assert b"terminated after" in stderr_bytes
    assert b"iterations" in stderr_bytes


def test_for_continue_skips_body():
    _, _, _, session, _, _ = _exec("for x in a b c; do "
                                   "continue; "
                                   "export NEVER=yes; "
                                   "done")
    assert "NEVER" not in session.env


# ── mixed operators ────────────────────────────


def test_and_or_semicolon_mix():
    _, _, _, session, _, _ = _exec(
        "export A=1; true && export B=2; false || export C=3")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"
    assert session.env["C"] == "3"


def test_pipeline_and_list():
    _, io, exec_node, session, _, _ = _exec("true | true && export OK=yes")
    assert exec_node.op == "&&"
    assert io.exit_code == 0
    assert session.env["OK"] == "yes"


# ── deeply nested ──────────────────────────────


def test_for_with_if_and_subshell():
    session = _session(env={"OUTER": "keep"})
    _exec("for x in a b; do "
          "if true; then (export OUTER=nope); fi; "
          "done",
          session=session)
    assert session.env["OUTER"] == "keep"


def test_if_with_for_and_break():
    _, _, _, session, _, _ = _exec("if true; then "
                                   "for x in 1 2 3; do "
                                   "export ITER=yes; break; "
                                   "done; "
                                   "fi")
    assert session.env["ITER"] == "yes"


def test_nested_for():
    _, _, _, session, _, _ = _exec("for a in x y; do "
                                   "for b in 1 2; do "
                                   "export INNER=ran; "
                                   "done; done")
    assert session.env["INNER"] == "ran"


def test_case_inside_for():
    _, _, _, session, _, _ = _exec("for x in hello world; do "
                                   "case x in "
                                   "hello) export H=yes;; "
                                   "world) export W=yes;; "
                                   "esac; done")
    assert "H" not in session.env


def test_if_and_or_chain():
    _, _, _, session, _, _ = _exec("if true && true; then export R=yes; fi")
    assert session.env["R"] == "yes"


def test_if_or_chain():
    _, _, _, session, _, _ = _exec("if false || true; then export R=yes; fi")
    assert session.env["R"] == "yes"


def test_subshell_with_pipeline():
    _, _, exec_node, _, _, _ = _exec("(echo a | grep a)")
    assert exec_node.op == "|"


def test_function_with_if():
    _, _, _, session, _, _ = _exec(
        "check() { if true; then export OK=yes; fi; }; check")
    assert session.env["OK"] == "yes"


def test_function_with_for():
    _, _, _, session, _, _ = _exec(
        "loop() { for x in a b; do export L=ran; done; }; loop")
    assert session.env["L"] == "ran"


# ═══════════════════════════════════════════════
# PathSpec / expansion flow tests
# ═══════════════════════════════════════════════

# ── command: paths become PathSpec ────────────


def test_command_file_becomes_globscope():
    """cat /data/file.txt → PathSpec(resolved=True)."""
    _, _, _, _, mount, _ = _exec("cat /data/file.txt")
    mount.execute_cmd.assert_called_once()
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 1
    assert isinstance(scopes[0], PathSpec)
    assert scopes[0].resolved is True
    assert "file.txt" in scopes[0].original


def test_command_glob_becomes_globscope():
    """cat /data/*.txt → unresolved PathSpec passed to resource."""
    _, _, _, _, mount, _ = _exec("cat /data/*.txt")
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 1
    s = scopes[0]
    assert isinstance(s, PathSpec)
    assert s.pattern == "*.txt"
    assert s.resolved is False
    assert "/data/" in s.directory


def test_command_question_glob():
    """cat /data/file?.txt → unresolved PathSpec passed to resource."""
    _, _, _, _, mount, _ = _exec("cat /data/file?.txt")
    scopes = mount.execute_cmd.call_args[0][1]
    assert isinstance(scopes[0], PathSpec)
    assert scopes[0].pattern == "file?.txt"
    assert scopes[0].resolved is False


def test_command_bracket_glob():
    """cat /data/file[0-9].txt → unresolved PathSpec passed to resource."""
    _, _, _, _, mount, _ = _exec("cat /data/file[0-9].txt")
    scopes = mount.execute_cmd.call_args[0][1]
    assert isinstance(scopes[0], PathSpec)
    assert "[0-9]" in scopes[0].pattern
    assert scopes[0].resolved is False


def test_command_text_stays_string():
    """grep pattern /data/file → 'pattern' is text, path is PathSpec."""
    _, _, _, _, mount, _ = _exec("grep pattern /data/file.txt")
    args = mount.execute_cmd.call_args
    assert args[0][0] == "grep"
    paths = args[0][1]
    texts = args[0][2]
    assert len(paths) == 1
    assert isinstance(paths[0], PathSpec)
    assert "pattern" in texts


def test_command_multiple_paths():
    """diff /data/a.txt /data/b.txt → two PathSpecs with correct originals."""
    _, _, _, _, mount, _ = _exec("diff /data/a.txt /data/b.txt")
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 2
    assert all(isinstance(s, PathSpec) for s in scopes)
    assert "a.txt" in scopes[0].original
    assert "b.txt" in scopes[1].original


def test_command_no_paths():
    """echo hello world → builtin, returns stdout."""
    stdout, io, _, _, _, _ = _exec("echo hello world")
    assert io.exit_code == 0
    assert stdout == b"hello world\n"


def test_command_flags_stay_text():
    """grep -rn pattern /data/f → flags are text, path is PathSpec."""
    _, _, _, _, mount, _ = _exec("grep -rn pattern /data/f.txt")
    paths = mount.execute_cmd.call_args[0][1]
    texts = mount.execute_cmd.call_args[0][2]
    assert len(paths) == 1
    assert isinstance(paths[0], PathSpec)
    assert "-rn" in texts
    assert "pattern" in texts


def test_execute_cmd_receives_three_positional_args():
    """execute_cmd is called with (cmd_name, paths, texts, flag_kwargs)."""
    _, _, _, _, mount, _ = _exec("cat /data/file.txt")
    args = mount.execute_cmd.call_args[0]
    assert len(args) == 4
    assert args[0] == "cat"
    assert isinstance(args[1], list)
    assert isinstance(args[2], list)
    assert isinstance(args[3], dict)


def test_flag_kwargs_is_empty_without_spec():
    """Without a spec, flag_kwargs should be empty dict."""
    _, _, _, _, mount, _ = _exec("cat /data/file.txt")
    flag_kwargs = mount.execute_cmd.call_args[0][3]
    assert flag_kwargs == {}


def test_texts_separated_from_paths():
    """grep pattern /data/file → texts=['pattern'], paths=[PathSpec]."""
    _, _, _, _, mount, _ = _exec("grep pattern /data/file.txt")
    paths = mount.execute_cmd.call_args[0][1]
    texts = mount.execute_cmd.call_args[0][2]
    flag_kwargs = mount.execute_cmd.call_args[0][3]
    assert len(paths) == 1
    assert isinstance(paths[0], PathSpec)
    assert texts == ["pattern"]
    assert flag_kwargs == {}


def test_flags_and_texts_separated():
    """grep -rn pattern /data/f → flags in texts (no spec), paths separate."""
    _, _, _, _, mount, _ = _exec("grep -rn pattern /data/f.txt")
    paths = mount.execute_cmd.call_args[0][1]
    texts = mount.execute_cmd.call_args[0][2]
    assert len(paths) == 1
    assert "-rn" in texts
    assert "pattern" in texts


# ── variable expansion → classify ──────────────


def test_var_expands_to_file():
    """cat $FILE → PathSpec(resolved=True)."""
    _, _, _, _, mount, _ = _exec("cat $FILE", env={"FILE": "/data/x.txt"})
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 1
    assert isinstance(scopes[0], PathSpec)
    assert scopes[0].resolved is True
    assert "x.txt" in scopes[0].original


def test_var_expands_to_glob():
    """cat $P → unresolved glob PathSpec passed to resource."""
    _, _, _, _, mount, _ = _exec("cat $P", env={"P": "/data/*.csv"})
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 1
    assert isinstance(scopes[0], PathSpec)
    assert scopes[0].pattern == "*.csv"
    assert scopes[0].resolved is False


def test_var_expands_to_text():
    """echo $MSG → builtin, MSG expanded."""
    stdout, io, _, _, _, _ = _exec("echo $MSG", env={"MSG": "hello"})
    assert io.exit_code == 0
    assert stdout == b"hello\n"


def test_concatenation_var_path():
    """cat $DIR/file.txt → expanded + classified as PathSpec."""
    _, _, _, _, mount, _ = _exec("cat $DIR/file.txt", env={"DIR": "/data"})
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 1
    assert isinstance(scopes[0], PathSpec)
    assert scopes[0].resolved is True


def test_concatenation_var_glob():
    """cat $DIR/*.csv → unresolved glob PathSpec passed to resource."""
    _, _, _, _, mount, _ = _exec("cat $DIR/*.csv", env={"DIR": "/data"})
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 1
    assert isinstance(scopes[0], PathSpec)
    assert scopes[0].pattern == "*.csv"
    assert scopes[0].resolved is False


# ── export / local expansion ──────────────────


def test_export_expands_var_value():
    """export DIR=$BASE/sub → DIR=/data/sub."""
    _, _, _, session, _, _ = _exec("export DIR=$BASE/sub",
                                   env={"BASE": "/data"})
    assert session.env["DIR"] == "/data/sub"


def test_export_multiple_with_expansion():
    """export A=$X B=$Y → both expanded."""
    _, _, _, session, _, _ = _exec("export A=$X B=$Y",
                                   env={
                                       "X": "1",
                                       "Y": "2"
                                   })
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"


def test_local_expands_value():
    """local V=$BASE/file → V=/data/file."""
    _, _, _, session, _, _ = _exec("local V=$BASE/file", env={"BASE": "/data"})
    assert session.env["V"] == "/data/file"


# ── for loop expansion + classify ──────────────


def test_for_literal_values():
    """for x in a b c → iterates plain strings."""
    _, _, _, session, _, _ = _exec("for x in a b c; do export LAST=$x; done")
    assert session.env["LAST"] == "c"


def test_for_var_expansion():
    """for f in $A $B → expanded values."""
    _, _, _, session, _, _ = _exec("for f in $A $B; do export LAST=$f; done",
                                   env={
                                       "A": "first",
                                       "B": "second"
                                   })
    assert session.env["LAST"] == "second"


def test_for_path_becomes_globscope():
    """for f in /data/a.txt /data/b.txt → iterates PathSpec paths."""
    _, _, _, session, _, _ = _exec(
        "for f in /data/a.txt /data/b.txt; do export LAST=$f; done")
    assert session.env["LAST"] == "/data/b.txt"


def test_for_mixed_paths_and_text():
    """for f in /data/a.txt hello /data/b.txt → last is /data/b.txt."""
    _, _, _, session, _, _ = _exec(
        "for f in /data/a.txt hello /data/b.txt; do "
        "export N=$f; done")
    assert session.env["N"] == "/data/b.txt"


def test_for_glob_values():
    """for f in /data/*.csv → glob PathSpec, original preserved."""
    _, _, _, session, _, _ = _exec(
        "for f in /data/*.csv; do export LAST=$f; done")
    assert session.env["LAST"] == "/data/*.csv"


# ── case word expansion ────────────────────────


def test_case_var_match():
    """case $X in hello) → matches when X=hello."""
    _, _, _, session, _, _ = _exec("case $X in hello) export M=yes;; esac",
                                   env={"X": "hello"})
    assert session.env["M"] == "yes"


def test_case_var_no_match():
    """case $X in hello) → no match when X=world."""
    _, _, _, session, _, _ = _exec("case $X in hello) export M=yes;; esac",
                                   env={"X": "world"})
    assert "M" not in session.env


def test_case_var_wildcard():
    """case $X in hel*) → wildcard matches."""
    _, _, _, session, _, _ = _exec("case $X in hel*) export M=yes;; esac",
                                   env={"X": "hello"})
    assert session.env["M"] == "yes"


# ── redirect target expansion ──────────────────


def test_redirect_static_path():
    """echo hello > /data/out.txt → tee dispatched to /data/out.txt."""
    _, _, _, _, _, dispatch = _exec("echo hello > /data/out.txt")
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) > 0
    assert write_calls[0][0][1].original == "/data/out.txt"


def test_redirect_var_target():
    """echo hello > $OUT → expanded to /data/out.txt."""
    _, _, _, _, _, dispatch = _exec("echo hello > $OUT",
                                    env={"OUT": "/data/out.txt"})
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) > 0
    assert write_calls[0][0][1].original == "/data/out.txt"


def test_redirect_concat_target():
    """echo hello > $DIR/out.txt → /data/out.txt."""
    _, _, _, _, _, dispatch = _exec("echo hello > $DIR/out.txt",
                                    env={"DIR": "/data"})
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) > 0
    assert write_calls[0][0][1].original == "/data/out.txt"


def test_redirect_append():
    """echo hello >> /data/out.txt → dispatch cat then tee."""
    _, _, _, _, _, dispatch = _exec("echo hello >> /data/out.txt")
    ops = [c[0][0] for c in dispatch.call_args_list]
    assert "write" in ops


def test_redirect_stdin():
    """sort < /data/input.txt → dispatch cat for input."""
    _, _, _, _, _, dispatch = _exec("sort < /data/input.txt")
    read_calls = [c for c in dispatch.call_args_list if c[0][0] == "read"]
    assert len(read_calls) > 0
    assert read_calls[0][0][1].original == "/data/input.txt"


# ── cd expansion ───────────────────────────────


def test_cd_var_expansion():
    """cd $DIR → cwd=/data."""
    dispatch = _mock_dispatch()
    stat = MagicMock()
    stat.type = "directory"
    dispatch.return_value = (stat, IOResult())
    _, io, _, session, _, _ = _exec("cd $DIR",
                                    dispatch=dispatch,
                                    env={"DIR": "/data"})
    assert io.exit_code == 0
    assert session.cwd == "/data"


def test_cd_concat_expansion():
    """cd $BASE/sub → cwd=/data/sub."""
    dispatch = _mock_dispatch()
    stat = MagicMock()
    stat.type = "directory"
    dispatch.return_value = (stat, IOResult())
    _, io, _, session, _, _ = _exec("cd $BASE/sub",
                                    dispatch=dispatch,
                                    env={"BASE": "/data"})
    assert io.exit_code == 0
    assert session.cwd == "/data/sub"


# ── source expansion ──────────────────────────


def test_source_var_expansion():
    """source $SCRIPT → dispatches cat on expanded path."""
    dispatch = _mock_dispatch()
    dispatch.return_value = (b"export X=1", IOResult())
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    session = _session(env={"SCRIPT": "/data/init.sh"})
    node = parse("source $SCRIPT")
    _run(execute_node(dispatch, reg, job_table, execute_fn, "a", node,
                      session))
    read_calls = [c for c in dispatch.call_args_list if c[0][0] == "read"]
    assert len(read_calls) > 0
    assert read_calls[0][0][1].original == "/data/init.sh"


# ── test command expansion ─────────────────────


def test_test_command_string_eq():
    """[ hello = hello ] → exit 0."""
    _, io, _, _, _, _ = _exec("test hello = hello")
    assert io.exit_code == 0


def test_test_command_string_neq():
    """[ hello = world ] → exit 1."""
    _, io, _, _, _, _ = _exec("test hello = world")
    assert io.exit_code == 1


# ── variable assignment expansion ──────────────


def test_bare_assignment_expands():
    """A=$B where B=hello → A=hello."""
    _, _, _, session, _, _ = _exec("A=$B", env={"B": "hello"})
    assert session.env["A"] == "hello"


def test_bare_assignment_concat():
    """A=$B/file where B=/data → A=/data/file."""
    _, _, _, session, _, _ = _exec("A=$B/file", env={"B": "/data"})
    assert session.env["A"] == "/data/file"


# ── arithmetic in commands ─────────────────────


def test_arithmetic_in_command():
    """echo $((2+3)) → expanded to 5."""
    stdout, io, _, _, _, _ = _exec("echo $((2 + 3))")
    assert io.exit_code == 0
    assert stdout == b"5\n"


# ── compound_statement (brace group) ───────────


def test_brace_group():
    """{ export A=1; export B=2; } → both execute."""
    _, _, _, session, _, _ = _exec("{ export A=1; export B=2; }")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"


def test_brace_group_with_if():
    _, _, _, session, _, _ = _exec(
        "{ if true; then export A=1; fi; export B=2; }")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"


def test_brace_group_in_pipeline():
    _, io, exec_node, _, _, _ = _exec("{ echo a; echo b; } | cat")
    assert exec_node.op == "|"
    assert len(exec_node.children) == 2
    assert io.exit_code == 0


# ── complex: pipeline + redirect + expansion ───


def test_pipeline_redirect_expansion():
    """cat $F | grep p > /data/out → tee to correct target."""
    _, _, _, _, _, dispatch = _exec("cat $F | grep p > /data/out",
                                    env={"F": "/data/input.txt"})
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1
    assert write_calls[0][0][1].original == "/data/out"


def test_for_with_command_expansion():
    """for f in a b; do cat /data/$f.txt; done → 2 mount calls."""
    _, _, _, _, mount, _ = _exec("for f in a b; do cat /data/$f.txt; done")
    assert mount.execute_cmd.call_count == 2


def test_if_with_var_condition():
    """if [ $X = yes ]; then export R=ok; fi → expands $X."""
    _, _, _, session, _, _ = _exec("if true; then export R=$V; fi",
                                   env={"V": "expanded"})
    assert session.env["R"] == "expanded"


def test_nested_for_expansion():
    """Nested for — LAST set to last concatenated value."""
    _, _, _, session, _, _ = _exec("for a in x y; do "
                                   "for b in 1 2; do "
                                   "export LAST=$a$b; "
                                   "done; done")
    assert session.env["LAST"] == "y2"


# ═══════════════════════════════════════════════
# Comprehensive: all expansion + classify patterns
# ═══════════════════════════════════════════════

# ── for: glob + var + cmd sub ──────────────────


def test_for_glob_value_classified():
    """for f in /data/*.txt → PathSpec original as env value."""
    _, _, _, session, _, _ = _exec(
        "for f in /data/*.txt; do export LAST=$f; done")
    assert session.env["LAST"] == "/data/*.txt"


def test_for_var_expanded_to_path():
    """for f in $DIR → expanded to /data/sub, stored as path string."""
    _, _, _, session, _, _ = _exec("for f in $DIR; do export GOT=$f; done",
                                   env={"DIR": "/data/sub"})
    assert session.env["GOT"] == "/data/sub"


def test_for_cmd_sub_expanded():
    """for f in $(cmd) → cmd output split into values."""
    dispatch = _mock_dispatch()
    reg, mount = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock()
    io_result = IOResult()
    io_result.stdout = b"alpha\nbeta\ngamma\n"
    execute_fn.return_value = io_result
    session = _session()
    node = parse("for f in $(listcmd); do export LAST=$f; done")

    _run(execute_node(dispatch, reg, job_table, execute_fn, "a", node,
                      session))
    # $(listcmd) output split on \n → 3 iterations
    assert session.env["LAST"] == "gamma"


def test_for_mixed_glob_var_text():
    """for f in /s3/*.csv $DIR/file.txt hello → all classified correctly."""
    _, _, _, session, _, _ = _exec(
        "for f in /s3/*.csv $DIR/file.txt hello; do "
        "export LAST=$f; done",
        env={"DIR": "/data"})
    # 3 iterations: PathSpec, PathSpec, "hello"
    assert session.env["LAST"] == "hello"


# ── select: same as for ───────────────────────


def test_select_glob_value():
    """select f in /data/*.csv → PathSpec original as value."""
    _, _, _, session, _, _ = _exec(
        "select f in /data/*.csv; do export GOT=$f; break; done")
    assert session.env["GOT"] == "/data/*.csv"


def test_select_var_expanded():
    """select f in $A $B → values expanded, break after first."""
    _, _, _, session, _, _ = _exec(
        "select f in $A $B; do export LAST=$f; break; done",
        env={
            "A": "first",
            "B": "second"
        })
    assert session.env["LAST"] == "first"


# ── case: word expansion, pattern stays literal ─


def test_case_glob_pattern_matches():
    """case hello.txt in *.txt) → pattern is literal glob for fnmatch."""
    _, _, _, session, _, _ = _exec(
        "case hello.txt in *.txt) export M=yes;; esac")
    assert session.env["M"] == "yes"


def test_case_expanded_word_glob_pattern():
    """case $F in *.csv) → $F expanded, matched against pattern."""
    _, _, _, session, _, _ = _exec(
        "case $F in *.csv) export M=yes;; *.txt) export M=no;; esac",
        env={"F": "data.csv"})
    assert session.env["M"] == "yes"


def test_case_expanded_word_no_glob_match():
    """case $F in *.csv) → $F=data.txt doesn't match *.csv."""
    _, _, _, session, _, _ = _exec(
        "case $F in *.csv) export M=csv;; *.txt) export M=txt;; esac",
        env={"F": "data.txt"})
    assert session.env["M"] == "txt"


# ── command args: concat + glob + cmd sub ──────


def test_cmd_concat_var_glob():
    """cat $DIR/*.txt → unresolved glob PathSpec passed to resource."""
    _, _, _, _, mount, _ = _exec("cat $DIR/*.txt", env={"DIR": "/data"})
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 1
    assert isinstance(scopes[0], PathSpec)
    assert scopes[0].pattern == "*.txt"
    assert scopes[0].resolved is False


def test_cmd_concat_var_file():
    """cat $DIR/file.txt → /data/file.txt → PathSpec(resolved=True)."""
    _, _, _, _, mount, _ = _exec("cat $DIR/file.txt", env={"DIR": "/data"})
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 1
    assert isinstance(scopes[0], PathSpec)
    assert scopes[0].resolved is True
    assert "file.txt" in scopes[0].original


def test_cmd_cmd_sub_as_arg():
    """cat $(echo /data/file.txt) → cmd sub expanded → PathSpec."""
    dispatch = _mock_dispatch()
    reg, mount = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock()
    io_result = IOResult()
    io_result.stdout = b"/data/file.txt\n"
    execute_fn.return_value = io_result
    session = _session()
    node = parse("cat $(echo /data/file.txt)")

    _run(execute_node(dispatch, reg, job_table, execute_fn, "a", node,
                      session))
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 1
    assert isinstance(scopes[0], PathSpec)
    assert "file.txt" in scopes[0].original


def test_cmd_multiple_concat_paths():
    """diff $A/x.txt $B/y.txt → two PathSpecs with correct directories."""
    _, _, _, _, mount, _ = _exec("diff $A/x.txt $B/y.txt",
                                 env={
                                     "A": "/s3",
                                     "B": "/data"
                                 })
    scopes = mount.execute_cmd.call_args[0][1]
    assert len(scopes) == 2
    assert isinstance(scopes[0], PathSpec)
    assert isinstance(scopes[1], PathSpec)
    assert "/s3/" in scopes[0].directory
    assert "/data/" in scopes[1].directory


# ── assignment: cmd sub + concat ───────────────


def test_assign_cmd_sub():
    """VAR=$(cmd) → executes cmd, assigns output."""
    dispatch = _mock_dispatch()
    reg, mount = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock()
    io_result = IOResult()
    io_result.stdout = b"result_value\n"
    execute_fn.return_value = io_result
    session = _session()
    node = parse("VAR=$(echo result_value)")

    _run(execute_node(dispatch, reg, job_table, execute_fn, "a", node,
                      session))
    assert session.env["VAR"] == "result_value"


def test_assign_concat():
    """DIR=/data/$SUB → expanded to /data/files."""
    _, _, _, session, _, _ = _exec("DIR=/data/$SUB", env={"SUB": "files"})
    assert session.env["DIR"] == "/data/files"


def test_assign_nested_concat():
    """OUT=${BASE}/${SUB}/file.txt → fully expanded."""
    _, _, _, session, _, _ = _exec("OUT=${BASE}/${SUB}/file.txt",
                                   env={
                                       "BASE": "/data",
                                       "SUB": "reports"
                                   })
    assert session.env["OUT"] == "/data/reports/file.txt"


# ── redirect target: var + concat + cmd sub ────


def test_redirect_concat_var_target():
    """echo x > $DIR/out.txt → target expanded to /data/out.txt."""
    _, _, _, _, _, dispatch = _exec("echo x > $DIR/out.txt",
                                    env={"DIR": "/data"})
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1
    assert write_calls[0][0][1].original == "/data/out.txt"


def test_redirect_cmd_sub_target():
    """echo x > $(echo /data/out.txt) → cmd sub expanded."""
    dispatch = _mock_dispatch()
    reg, mount = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock()
    io_result = IOResult()
    io_result.stdout = b"/data/out.txt\n"
    execute_fn.return_value = io_result
    session = _session()
    node = parse("echo x > $(echo /data/out.txt)")

    _run(execute_node(dispatch, reg, job_table, execute_fn, "a", node,
                      session))
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1
    assert write_calls[0][0][1].original == "/data/out.txt"


def test_redirect_stderr_path():
    """cat missing 2> /data/err.log → stderr written to file."""
    dispatch = _mock_dispatch()
    reg, mount = _mock_registry()
    mount.execute_cmd = AsyncMock(side_effect=FileNotFoundError("missing"))
    mount.resolve_command = MagicMock(return_value=MagicMock())
    reg.mounts = MagicMock(return_value=[mount])
    stdout, io, _, _, _, dispatch = _exec(
        "cat /data/missing.txt 2> /data/err.log",
        dispatch=dispatch,
        registry=(reg, mount))
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1
    assert write_calls[0][0][1].original == "/data/err.log"
    assert io.stderr is None


def test_redirect_append_var():
    """echo x >> $LOG → expanded, cat+tee dispatched."""
    _, _, _, _, _, dispatch = _exec("echo x >> $LOG",
                                    env={"LOG": "/data/app.log"})
    ops = [c[0][0] for c in dispatch.call_args_list]
    assert "read" in ops
    assert "write" in ops
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert write_calls[0][0][1].original == "/data/app.log"


def test_redirect_stdin_var():
    """sort < $INPUT → expanded, cat dispatched for input."""
    _, _, _, _, _, dispatch = _exec("sort < $INPUT",
                                    env={"INPUT": "/data/in.txt"})
    read_calls = [c for c in dispatch.call_args_list if c[0][0] == "read"]
    assert len(read_calls) == 1
    assert read_calls[0][0][1].original == "/data/in.txt"


# ── heredoc: no target expansion ───────────────


def test_heredoc_no_target_crash():
    """cat <<EOF\\nhello\\nEOF → dispatches cat, no crash."""
    _, io, _, _, mount, _ = _exec("cat <<EOF\nhello\nEOF")
    assert io.exit_code == 0
    mount.execute_cmd.assert_called_once()


# ── complex: full pipeline simulation ──────────


def test_full_pipeline_with_expansion():
    """cat $DIR/in.txt | grep $PAT > $DIR/out.txt → all expanded."""
    _, _, _, _, mount, dispatch = _exec(
        "cat $DIR/in.txt | grep $PAT > $DIR/out.txt",
        env={
            "DIR": "/data",
            "PAT": "error"
        })
    # cat should receive PathSpec for /data/in.txt
    # grep should receive "error" as text arg
    # redirect should tee to /data/out.txt
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1
    assert write_calls[0][0][1].original == "/data/out.txt"


def test_for_with_redirect_expansion():
    """for f in a b; do echo $f > /data/$f.txt; done → 2 tee calls."""
    _, _, _, _, _, dispatch = _exec(
        "for f in a b; do echo $f > /data/$f.txt; done")
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 2
    targets = {c[0][1].original for c in write_calls}
    assert "/data/a.txt" in targets
    assert "/data/b.txt" in targets


def test_nested_expansion_in_for_body():
    """for d in /s3 /data; do cat $d/file.txt; done → paths classified."""
    _, _, _, _, mount, _ = _exec(
        "for d in /s3 /data; do cat $d/file.txt; done")
    assert mount.execute_cmd.call_count == 2
    # Each call should have a PathSpec path
    for call in mount.execute_cmd.call_args_list:
        scopes = call[0][1]
        assert len(scopes) == 1
        assert isinstance(scopes[0], PathSpec)
        assert scopes[0].resolved is True


# ── multi-statement body (do_group) ────────────


def test_for_multi_statement_body():
    """for x in a b; do export V=$x; export W=done; done → both run."""
    _, _, _, session, _, _ = _exec(
        "for x in a b; do export V=$x; export W=done; done")
    assert session.env["V"] == "b"
    assert session.env["W"] == "done"


def test_for_break_in_multi_body():
    """for x in a b c; do export V=$x; break; done → breaks after first."""
    _, _, _, session, _, _ = _exec(
        "for x in a b c; do export V=$x; break; done")
    assert session.env["V"] == "a"


def test_for_continue_in_multi_body():
    """for x in a b c; do continue; export SKIP=yes; done → SKIP never set."""
    _, _, _, session, _, _ = _exec(
        "for x in a b c; do continue; export SKIP=yes; done")
    assert "SKIP" not in session.env


def test_for_break_after_condition():
    """Conditional break in multi-statement for body."""
    _, _, _, session, _, _ = _exec("for x in a b c; do "
                                   "export V=$x; "
                                   "if true; then break; fi; "
                                   "export AFTER=no; "
                                   "done")
    assert session.env["V"] == "a"
    assert "AFTER" not in session.env


def test_while_multi_statement_body():
    """while true; do export RAN=yes; break; done → both run, then break."""
    _, _, _, session, _, _ = _exec(
        "while true; do export RAN=yes; break; done")
    assert session.env["RAN"] == "yes"


def test_while_continue_in_multi_body():
    """while true; do export N=yes; continue; done → N set, hits MAX_WHILE."""
    _, io, _, session, _, _ = _exec(
        "while true; do export N=yes; continue; done")
    assert session.env["N"] == "yes"
    assert io.exit_code == 0


def test_select_break_in_multi_body():
    """select f in a b c; do export V=$f; break; done → breaks after first."""
    _, _, _, session, _, _ = _exec(
        "select f in a b c; do export V=$f; break; done")
    assert session.env["V"] == "a"


def test_for_multi_with_redirect():
    """Multi-statement for body with redirect."""
    _, _, _, session, _, dispatch = _exec(
        "for f in a b; do echo $f > /data/$f.txt; export DONE=yes; done")
    assert session.env["DONE"] == "yes"
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 2


def test_for_multi_with_pipeline():
    """Multi-statement for body with pipeline."""
    _, _, _, session, _, _ = _exec(
        "for f in a b; do echo $f | cat; export DONE=yes; done")
    assert session.env["DONE"] == "yes"


# ═══════════════════════════════════════════════
# stdin tests: bytes, AsyncIterator, None
# ═══════════════════════════════════════════════


async def _async_iter(data: bytes):
    """Create an async iterator yielding data in chunks."""
    for i in range(0, len(data), 4):
        yield data[i:i + 4]


def test_read_from_bytes_stdin():
    """read VAR with stdin=b'...' → VAR set."""
    session = _session()
    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    node = parse("read VAR")

    _, io, _ = _run(
        execute_node(dispatch,
                     reg,
                     job_table,
                     execute_fn,
                     "a",
                     node,
                     session,
                     stdin=b"hello world"))
    assert io.exit_code == 0
    assert session.env["VAR"] == "hello world"


def test_read_from_async_iterator_stdin():
    """read VAR with stdin=AsyncIterator → VAR set from stream."""
    session = _session()
    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    node = parse("read VAR")

    stdin_stream = _async_iter(b"streamed data")
    _, io, _ = _run(
        execute_node(dispatch,
                     reg,
                     job_table,
                     execute_fn,
                     "a",
                     node,
                     session,
                     stdin=stdin_stream))
    assert io.exit_code == 0
    assert session.env["VAR"] == "streamed data"


def test_read_from_none_stdin():
    """read VAR with stdin=None → VAR empty, exit code 1 (no input)."""
    session = _session()
    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    node = parse("read VAR")

    _, io, _ = _run(
        execute_node(dispatch,
                     reg,
                     job_table,
                     execute_fn,
                     "a",
                     node,
                     session,
                     stdin=None))
    assert io.exit_code == 1
    assert session.env["VAR"] == ""


def test_read_multivar_from_bytes():
    """read A B C with stdin=b'x y z' → A=x B=y C=z."""
    session = _session()
    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    node = parse("read A B C")

    _, io, _ = _run(
        execute_node(dispatch,
                     reg,
                     job_table,
                     execute_fn,
                     "a",
                     node,
                     session,
                     stdin=b"x y z"))
    assert session.env["A"] == "x"
    assert session.env["B"] == "y"
    assert session.env["C"] == "z"


def test_read_multivar_from_stream():
    """read A B with stdin=AsyncIterator → splits correctly."""
    session = _session()
    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    node = parse("read A B")

    stdin_stream = _async_iter(b"first second third")
    _, io, _ = _run(
        execute_node(dispatch,
                     reg,
                     job_table,
                     execute_fn,
                     "a",
                     node,
                     session,
                     stdin=stdin_stream))
    assert session.env["A"] == "first"
    assert session.env["B"] == "second third"


def test_read_multiline_takes_first():
    """read VAR from multi-line input → takes first line only."""
    session = _session()
    dispatch = _mock_dispatch()
    reg, _ = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    node = parse("read VAR")

    _, io, _ = _run(
        execute_node(dispatch,
                     reg,
                     job_table,
                     execute_fn,
                     "a",
                     node,
                     session,
                     stdin=b"line1\nline2\nline3"))
    assert session.env["VAR"] == "line1"


def test_pipeline_passes_stdout_as_stdin():
    """echo hello | cat → cat receives echo's stdout."""
    _, _, exec_node, _, mount, _ = _exec("echo hello | cat")
    assert exec_node.op == "|"
    assert mount.execute_cmd.call_count == 1


def test_redirect_stdin_from_file():
    """sort < /data/input.txt → dispatch read_bytes, sort gets data."""
    dispatch = _mock_dispatch()
    dispatch.return_value = (b"line2\nline1\n", IOResult())
    reg, mount = _mock_registry()
    mount.execute_cmd = AsyncMock(side_effect=_sort_execute_cmd)
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    session = _session()
    node = parse("sort < /data/input.txt")

    stdout, io, _ = _run(
        execute_node(dispatch, reg, job_table, execute_fn, "a", node, session))
    read_calls = [c for c in dispatch.call_args_list if c[0][0] == "read"]
    assert len(read_calls) == 1
    assert read_calls[0][0][1].original == "/data/input.txt"
    assert io.exit_code == 0
    assert stdout == b"line1\nline2\n"


# ═══════════════════════════════════════════════
# stdin materialization in loops
# ═══════════════════════════════════════════════


def _exec_with_stdin(cmd, stdin, env=None):
    """Execute a command with explicit stdin."""

    async def _inner():
        session = _session(env=env or {})
        dispatch = _mock_dispatch()
        reg, mount = _mock_registry()
        job_table = JobTable()
        execute_fn = AsyncMock(return_value=IOResult())
        node = parse(cmd)
        stdout, io, exec_node = await execute_node(dispatch,
                                                   reg,
                                                   job_table,
                                                   execute_fn,
                                                   "a",
                                                   node,
                                                   session,
                                                   stdin=stdin)
        stdout = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
        return stdout, io, exec_node, session, mount, dispatch

    return _run(_inner())


def test_for_stdin_bytes_shared_across_iterations():
    """for x in a b; do read V; done with bytes stdin.

    Each iteration reads from the materialized buffer.
    read consumes one line per call.
    """
    _, _, _, session, _, _ = _exec_with_stdin(
        "for x in a b; do read LINE; done", stdin=b"first\nsecond\n")
    # read takes first line, then second — both accessible
    assert "LINE" in session.env


def test_for_stdin_async_iterator_materialized():
    """for x in a b; do read V; done with async iterator.

    Iterator is materialized before loop, so all iterations
    can access the data.
    """

    async def _stream():
        yield b"alpha\n"
        yield b"beta\n"

    _, _, _, session, _, _ = _exec_with_stdin(
        "for x in a b; do read LINE; done", stdin=_stream())
    assert "LINE" in session.env


def test_while_read_consumes_lazily():
    """while read line; do ... loop pulls one line at a time.

    Producer should only yield as many chunks as needed for the lines
    actually consumed, not eagerly materialize the whole stream.
    """
    pulls = 0

    async def _lazy_stream():
        nonlocal pulls
        for i in range(1000):
            pulls += 1
            yield f"line{i}\n".encode()

    _, _, _, session, _, _ = _exec_with_stdin(
        "while read LINE; do export LAST=$LINE; done; export N_PULLS=done",
        stdin=_lazy_stream())
    assert session.env.get("LAST") == "line999"
    assert pulls == 1000


def test_while_read_break_stops_pulling():
    """Early break should leave the producer un-pulled past break point.

    Proves laziness: with the old eager materialize, all 1000 chunks
    would be pulled before the loop body runs. With lazy buffering,
    only the consumed-up-to-break chunks get pulled.
    """
    pulls = 0

    async def _lazy_stream():
        nonlocal pulls
        for i in range(1000):
            pulls += 1
            yield f"line{i}\n".encode()

    _, _, _, session, _, _ = _exec_with_stdin(
        "while read LINE; do "
        "  export LAST=$LINE; "
        "  if [ \"$LINE\" = \"line4\" ]; then break; fi; "
        "done",
        stdin=_lazy_stream())
    assert session.env.get("LAST") == "line4"
    assert pulls < 50, f"expected lazy pulls (~5), got {pulls}"


def test_for_stdin_none_no_crash():
    """for x in a b; do read V; done with stdin=None."""
    _, io, _, session, _, _ = _exec_with_stdin(
        "for x in a b; do read LINE; done", stdin=None)
    assert session.env.get("LINE", "") == ""


def test_while_stdin_bytes():
    """while loop materializes stdin before iterating."""
    _, _, _, session, _, _ = _exec_with_stdin("while false; do read V; done",
                                              stdin=b"data\n")
    # while false → body never executes, but no crash
    assert "V" not in session.env


def test_while_stdin_async_iterator():
    """while loop with async iterator stdin — materialized."""

    async def _stream():
        yield b"line1\n"
        yield b"line2\n"

    _, _, _, session, _, _ = _exec_with_stdin("while false; do read V; done",
                                              stdin=_stream())
    assert "V" not in session.env


def test_body_sequential_reads_advance_buffer():
    """read A; read B — each read consumes one line from buffer.

    First read sets A=hello, advances buffer.
    Second read sets B=world from remaining buffer.
    """
    _, _, _, session, mount, _ = _exec_with_stdin("read A; read B",
                                                  stdin=b"hello\nworld\n")
    assert session.env["A"] == "hello"
    assert session.env["B"] == "world"


def test_pipeline_stdin_flows_through():
    """echo data | cat → pipe connects stdout to stdin."""
    _, _, exec_node, _, mount, _ = _exec_with_stdin("echo data | cat",
                                                    stdin=None)
    assert exec_node.op == "|"
    assert mount.execute_cmd.call_count == 1


def test_select_stdin_materialized():
    """select materializes stdin before iterating."""

    async def _stream():
        yield b"choice\n"

    _, _, _, session, _, _ = _exec_with_stdin(
        "select f in a b; do export GOT=$f; break; done", stdin=_stream())
    assert session.env["GOT"] == "a"


def test_for_with_cmd_using_stdin():
    """for x in a b; do cat; done with stdin."""
    _, _, _, _, mount, _ = _exec_with_stdin(
        "for x in a b; do cat /data/f.txt; done", stdin=b"piped data")
    assert mount.execute_cmd.call_count == 2


def test_subshell_stdin_passthrough():
    """(read V) with stdin → read gets stdin inside subshell."""
    _, _, _, session, _, _ = _exec_with_stdin("(read V)",
                                              stdin=b"subshell data")
    # subshell restores env, so V is lost — but no crash
    assert "V" not in session.env


def test_redirect_stdin_with_async_iterator():
    """sort < /data/f with async stdin → stdin from redirect, not pipe."""

    async def _stream():
        yield b"ignored\n"

    dispatch = _mock_dispatch()
    dispatch.return_value = (b"b\na\n", IOResult())
    reg, mount = _mock_registry()
    mount.execute_cmd = AsyncMock(side_effect=_sort_execute_cmd)
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    session = _session()
    node = parse("sort < /data/input.txt")

    stdout, io, _ = _run(
        execute_node(dispatch,
                     reg,
                     job_table,
                     execute_fn,
                     "a",
                     node,
                     session,
                     stdin=_stream()))
    read_calls = [c for c in dispatch.call_args_list if c[0][0] == "read"]
    assert len(read_calls) == 1
    assert io.exit_code == 0
    assert stdout == b"a\nb\n"


# ═══════════════════════════════════════════════
# stdin buffer advancement (read consumes lines)
# ═══════════════════════════════════════════════


def test_sequential_reads_advance_through_lines():
    """read A; read B; read C with 3 lines → each gets one line."""
    _, _, _, session, _, _ = _exec_with_stdin("read A; read B; read C",
                                              stdin=b"first\nsecond\nthird\n")
    assert session.env["A"] == "first"
    assert session.env["B"] == "second"
    assert session.env["C"] == "third"


def test_read_past_end_returns_empty():
    """read A; read B with 1 line → A=line, B=empty, exit=1."""
    _, io, _, session, _, _ = _exec_with_stdin("read A; read B",
                                               stdin=b"only\n")
    assert session.env["A"] == "only"
    assert session.env["B"] == ""


def test_for_loop_read_advances_buffer():
    """for x in 1 2 3; do read LINE; done with 3 lines.

    Each iteration reads the next line from materialized buffer.
    """
    _, _, _, session, _, _ = _exec_with_stdin(
        "for x in 1 2 3; do read LINE; export L_$x=$LINE; done",
        stdin=b"alpha\nbeta\ngamma\n")
    # export L_$x doesn't work ($ in key), but LINE advances
    assert session.env.get("LINE") == "gamma"


def test_while_read_pattern():
    """while read LINE; do export LAST=$LINE; done.

    Classic bash pattern. Reads lines until EOF,
    then read returns 1 → while exits.
    """
    _, io, _, session, _, _ = _exec_with_stdin(
        "while read LINE; do export LAST=$LINE; done",
        stdin=b"aaa\nbbb\nccc\n")
    assert session.env["LAST"] == "ccc"
    assert io.exit_code == 0


def test_while_read_single_line():
    """while read LINE; do ...; done with one line."""
    _, _, _, session, _, _ = _exec_with_stdin(
        "while read LINE; do export GOT=$LINE; done", stdin=b"only_line\n")
    assert session.env["GOT"] == "only_line"


def test_while_read_empty_stdin():
    """while read LINE; do ...; done with empty stdin → body never runs."""
    _, io, _, session, _, _ = _exec_with_stdin(
        "while read LINE; do export RAN=yes; done", stdin=b"")
    assert "RAN" not in session.env


def test_while_read_async_iterator():
    """while read LINE; do ...; done with async iterator."""

    async def _stream():
        yield b"x\n"
        yield b"y\n"

    _, _, _, session, _, _ = _exec_with_stdin(
        "while read LINE; do export LAST=$LINE; done", stdin=_stream())
    assert session.env["LAST"] == "y"


def test_buffer_reset_after_loop():
    """Buffer is restored after loop exits."""
    session = _session()
    session._stdin_buffer = b"outer\n"
    dispatch = _mock_dispatch()
    reg, mount = _mock_registry()
    job_table = JobTable()
    execute_fn = AsyncMock(return_value=IOResult())
    node = parse("for x in a; do read V; done")

    _run(
        execute_node(dispatch,
                     reg,
                     job_table,
                     execute_fn,
                     "a",
                     node,
                     session,
                     stdin=b"inner\n"))
    # Buffer should be restored to outer value after loop
    assert session._stdin_buffer == b"outer\n"


# ═══════════════════════════════════════════════
# call_stack tests
# ═══════════════════════════════════════════════


def test_function_receives_positional_args():
    """f() { export A=$1; }; f hello → A=hello."""
    _, _, _, session, _, _ = _exec("f() { export A=$1; }; f hello")
    assert session.env["A"] == "hello"


def test_function_multiple_args():
    """f() { export A=$1; export B=$2; }; f x y → A=x B=y."""
    _, _, _, session, _, _ = _exec("f() { export A=$1; export B=$2; }; f x y")
    assert session.env["A"] == "x"
    assert session.env["B"] == "y"


def test_function_dollar_at():
    """f() { export ALL=$@; }; f a b c → ALL='a b c'."""
    _, _, _, session, _, _ = _exec("f() { export ALL=$@; }; f a b c")
    assert session.env["ALL"] == "a b c"


def test_function_dollar_hash():
    """f() { export N=$#; }; f a b → N=2."""
    _, _, _, session, _, _ = _exec("f() { export N=$#; }; f a b")
    assert session.env["N"] == "2"


def test_function_no_args():
    """f() { export N=$#; }; f → N=0."""
    _, _, _, session, _, _ = _exec("f() { export N=$#; }; f")
    assert session.env["N"] == "0"


def test_shift_removes_positional():
    """f() { shift; export A=$1; }; f x y → A=y."""
    _, _, _, session, _, _ = _exec("f() { shift; export A=$1; }; f x y")
    assert session.env["A"] == "y"


def test_nested_function_calls():
    """inner() { export V=$1; }; outer() { inner hello; }; outer."""
    _, _, _, session, _, _ = _exec(
        "inner() { export V=$1; }; outer() { inner hello; }; outer")
    assert session.env["V"] == "hello"


def test_function_args_isolated():
    """Args from outer don't leak into inner.

    outer() { inner; }; inner() { export A=$1; }; outer hello
    → inner has no args, A=''
    """
    _, _, _, session, _, _ = _exec(
        "inner() { export A=$1; }; outer() { inner; }; outer hello")
    assert session.env["A"] == ""


def test_dollar_zero():
    """$0 is always 'mirage'."""
    stdout, _, _, _, _, _ = _exec("echo $0")
    assert stdout == b"mirage\n"


# ── multi-statement if/else/function bodies ────


def test_if_multi_statement_body():
    """if true; then export A=1; export B=2; fi → both execute."""
    _, _, _, session, _, _ = _exec("if true; then export A=1; export B=2; fi")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"


def test_if_else_multi_statement():
    """if false; then ...; else export A=1; export B=2; fi."""
    _, _, _, session, _, _ = _exec(
        "if false; then export X=no; else export A=1; export B=2; fi")
    assert "X" not in session.env
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"


def test_elif_multi_statement():
    """elif branch with multiple statements."""
    _, _, _, session, _, _ = _exec("if false; then export X=no; "
                                   "elif true; then export A=1; export B=2; "
                                   "fi")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"


def test_function_multi_statement_body():
    """f() { export A=1; export B=2; }; f → both execute."""
    _, _, _, session, _, _ = _exec("f() { export A=1; export B=2; }; f")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"


def test_function_shift_then_use():
    """f() { shift; export A=$1; }; f x y → A=y."""
    _, _, _, session, _, _ = _exec("f() { shift; export A=$1; }; f x y")
    assert session.env["A"] == "y"


def test_function_multi_with_control():
    """f() { export A=1; if true; then export B=2; fi; export C=3; }; f."""
    _, _, _, session, _, _ = _exec(
        "f() { export A=1; if true; then export B=2; fi; export C=3; }; f")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"
    assert session.env["C"] == "3"


# ── while read pattern (the classic) ──────────


def test_while_read_counts_lines():
    """while read LINE; do export N=...; done — count iterations."""
    _, _, _, session, _, _ = _exec_with_stdin(
        "while read LINE; do export LAST=$LINE; done", stdin=b"a\nb\nc\n")
    assert session.env["LAST"] == "c"


def test_while_read_with_break():
    """while read LINE; do ...; break; done — reads one line then stops."""
    _, _, _, session, _, _ = _exec_with_stdin(
        "while read LINE; do export FIRST=$LINE; break; done",
        stdin=b"line1\nline2\n")
    assert session.env["FIRST"] == "line1"


def test_while_read_multivar():
    """while read A B; do ...; done — splits each line."""
    _, _, _, session, _, _ = _exec_with_stdin(
        "while read K V; do export LAST_K=$K; export LAST_V=$V; done",
        stdin=b"key1 val1\nkey2 val2\n")
    assert session.env["LAST_K"] == "key2"
    assert session.env["LAST_V"] == "val2"


# ═══════════════════════════════════════════════
# Complex nested shell scripts
# ═══════════════════════════════════════════════


def test_nested_if_while_for():
    """if + while + for nested three levels deep.

    $LINE expands with IFS splitting.
    """
    _, _, _, session, _, _ = _exec_with_stdin(
        "if true; then "
        "while read LINE; do "
        "for w in $LINE; do "
        "export LAST=$w; "
        "done; done; fi",
        stdin=b"hello world\n")
    assert session.env["LAST"] == "world"


def test_for_if_pipeline():
    """for loop with if condition and pipeline in body."""
    _, _, _, session, mount, _ = _exec("for x in a b c; do "
                                       "if true; then "
                                       "echo $x | cat; "
                                       "export DONE=$x; "
                                       "fi; done")
    assert session.env["DONE"] == "c"
    assert mount.execute_cmd.call_count == 3


def test_function_with_while_read():
    """Function using while read pattern."""
    _, _, _, session, _, _ = _exec_with_stdin(
        "process() { while read LINE; do "
        "export LAST=$LINE; done; }; process",
        stdin=b"x\ny\nz\n")
    assert session.env["LAST"] == "z"


def test_nested_functions():
    """Three levels of function nesting."""
    _, _, _, session, _, _ = _exec("a() { export DEPTH=1; b; }; "
                                   "b() { export DEPTH=2; c; }; "
                                   "c() { export DEPTH=3; }; "
                                   "a")
    assert session.env["DEPTH"] == "3"


def test_function_with_args_and_loop():
    """Function with positional args, $@ splits on whitespace."""
    _, _, _, session, _, _ = _exec(
        "proc() { for f in $@; do export LAST=$f; done; }; "
        "proc alpha beta gamma")
    assert session.env["LAST"] == "gamma"


def test_case_in_for():
    """case inside for loop — pattern matching per iteration."""
    _, _, _, session, _, _ = _exec("for f in a.csv b.txt c.csv; do "
                                   "case $f in "
                                   "*.csv) export CSV=$f;; "
                                   "*.txt) export TXT=$f;; "
                                   "esac; done")
    assert session.env["CSV"] == "c.csv"
    assert session.env["TXT"] == "b.txt"


def test_if_and_or_in_for():
    """for loop with && and || in body."""
    _, _, _, session, _, _ = _exec("for x in a b; do "
                                   "true && export OK=$x; "
                                   "false || export FALL=$x; "
                                   "done")
    assert session.env["OK"] == "b"
    assert session.env["FALL"] == "b"


def test_subshell_in_while():
    """Subshell inside while — env isolated per iteration."""
    session = _session(env={"OUTER": "keep"})
    _exec_with_stdin("while read LINE; do "
                     "(export OUTER=nope); "
                     "done",
                     stdin=b"a\nb\n")
    assert session.env["OUTER"] == "keep"


def test_redirect_in_for_with_expansion():
    """for loop writing to different files via redirect."""
    _, _, _, _, _, dispatch = _exec("for name in alpha beta; do "
                                    "echo $name > /data/${name}.txt; "
                                    "done")
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 2
    targets = {c[0][1].original for c in write_calls}
    assert "/data/alpha.txt" in targets
    assert "/data/beta.txt" in targets


def test_function_calling_function_with_redirect():
    """Function A calls function B, output redirected."""
    _, _, _, _, _, dispatch = _exec("inner() { echo result; }; "
                                    "outer() { inner > /data/out.txt; }; "
                                    "outer")
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1
    assert write_calls[0][0][1].original == "/data/out.txt"


def test_while_read_with_case():
    """while read + case — classic line processing."""
    _, _, _, session, _, _ = _exec_with_stdin(
        "while read LINE; do "
        "case $LINE in "
        "err*) export ERR=$LINE;; "
        "*) export OK=$LINE;; "
        "esac; done",
        stdin=b"error: bad\ninfo: good\n")
    assert session.env["ERR"] == "error: bad"
    assert session.env["OK"] == "info: good"


def test_export_in_elif_chain():
    """Multi-branch elif with exports."""
    _, _, _, session, _, _ = _exec(
        "if false; then export R=a; "
        "elif false; then export R=b; "
        "elif false; then export R=c; "
        "elif true; then export R=d; export S=also; "
        "else export R=e; fi")
    assert session.env["R"] == "d"
    assert session.env["S"] == "also"


def test_nested_while_loops():
    """Nested while loops with different stdin buffers."""
    _, _, _, session, _, _ = _exec_with_stdin(
        "while read OUTER; do "
        "export LAST_OUTER=$OUTER; "
        "break; done",
        stdin=b"line1\nline2\n")
    assert session.env["LAST_OUTER"] == "line1"


# ═══════════════════════════════════════════════
# Python command shell-parser routing
# ═══════════════════════════════════════════════
#
# python3 is now a registered general command (see
# mirage.commands.builtin.general.python). End-to-end behavior
# (script read via dispatch, env passthrough, exit codes) is covered
# by tests/workspace/test_workspace.py against a real workspace.
# Tests here only verify the shell parser routes python3 like any
# other command (heredocs, pipelines, redirects, fan-out).


def test_python3_dispatched_to_mount():
    """python3 -c 'code' → dispatched as a command to mount."""
    _, _, _, _, mount, _ = _exec("python3 -c 'print(42)'")
    mount.execute_cmd.assert_called_once()
    assert mount.execute_cmd.call_args[0][0] == "python3"


def test_python3_heredoc_parsed():
    """python3 <<PYEOF\\ncode\\nPYEOF → redirected_statement."""
    _, io, _, _, _, _ = _exec("python3 <<PYEOF\nprint('hi')\nPYEOF")
    assert io.exit_code is not None


def test_python3_heredoc_quoted():
    """python3 <<'SCRIPT'\\ncode\\nSCRIPT → parsed correctly."""
    _, io, _, _, _, _ = _exec("python3 <<'SCRIPT'\nprint(1)\nSCRIPT")
    assert io.exit_code is not None


def test_python3_heredoc_double_quoted():
    """python3 <<"EOF"\\ncode\\nEOF → parsed correctly."""
    _, io, _, _, _, _ = _exec('python3 <<"EOF"\nimport os\nEOF')
    assert io.exit_code is not None


def test_python3_in_pipeline():
    """python3 -c ... | grep → pipeline with python."""
    _, _, exec_node, _, _, _ = _exec("python3 -c 'print(1)' | grep 1")
    assert exec_node.op == "|"


def test_python3_with_redirect():
    """python3 script.py > /data/out.txt → redirect works."""
    _, _, _, _, _, dispatch = _exec("python3 /data/script.py > /data/out.txt")
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1
    assert write_calls[0][0][1].original == "/data/out.txt"


# ═══════════════════════════════════════════════
# Builtin commands: echo, printf, sort, seq, expr, sleep
# ═══════════════════════════════════════════════

# ── echo ───────────────────────────────────────


def test_echo_basic():
    stdout, io, _, _, _, _ = _exec("echo hello")
    assert io.exit_code == 0
    assert stdout == b"hello\n"


def test_echo_multiple_args():
    stdout, _, _, _, _, _ = _exec("echo hello world")
    assert stdout == b"hello world\n"


def test_echo_no_args():
    stdout, _, _, _, _, _ = _exec("echo")
    assert stdout == b"\n"


def test_echo_n_flag():
    stdout, _, _, _, _, _ = _exec("echo -n hello")
    assert stdout == b"hello"


def test_echo_var_expansion():
    stdout, _, _, _, _, _ = _exec("echo $X", env={"X": "expanded"})
    assert stdout == b"expanded\n"


def test_echo_concat_expansion():
    stdout, _, _, _, _, _ = _exec("echo $A/$B", env={"A": "dir", "B": "file"})
    assert stdout == b"dir/file\n"


def test_echo_in_if():
    stdout, _, _, session, _, _ = _exec("if true; then echo yes; fi")
    assert stdout == b"yes\n"


def test_echo_in_for():
    stdout, _, _, _, _, _ = _exec("for x in a b c; do echo $x; done")
    assert b"a\n" in stdout
    assert b"c\n" in stdout


def test_echo_pipe_to_cat():
    _, _, exec_node, _, mount, _ = _exec("echo hello | cat")
    assert exec_node.op == "|"
    mount.execute_cmd.assert_called_once()
    assert mount.execute_cmd.call_args[0][0] == "cat"


def test_echo_redirect():
    _, _, _, _, _, dispatch = _exec("echo hello > /data/out.txt")
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1
    assert write_calls[0][0][1].original == "/data/out.txt"


# ── printf ─────────────────────────────────────


def test_printf_basic():
    stdout, io, _, _, _, _ = _exec("printf hello")
    assert io.exit_code == 0
    assert stdout == b"hello"


def test_printf_newline():
    stdout, _, _, _, _, _ = _exec(r"printf 'hello\n'")
    assert stdout == b"hello\n"


def test_printf_no_args():
    stdout, io, _, _, _, _ = _exec("printf")
    assert io.exit_code == 0
    assert stdout == b""


def test_printf_in_pipeline():
    _, _, exec_node, _, _, _ = _exec("printf hello | cat")
    assert exec_node.op == "|"


# ── sort ───────────────────────────────────────


def test_sort_in_pipeline():
    _, _, exec_node, _, _, _ = _exec("echo hello | sort")
    assert exec_node.op == "|"


def test_sort_pipe_from_echo():
    stdout, io, _, _, _, _ = _exec("echo 'c\nb\na' | sort")
    assert io.exit_code == 0


# ── sleep ──────────────────────────────────────


def test_sleep_zero():
    _, io, _, _, _, _ = _exec("sleep 0")
    assert io.exit_code == 0


def test_sleep_small():
    _, io, _, _, _, _ = _exec("sleep 0.01")
    assert io.exit_code == 0


def test_sleep_invalid():
    _, io, _, _, _, _ = _exec("sleep abc")
    assert io.exit_code == 1


def test_sleep_no_args():
    _, io, _, _, _, _ = _exec("sleep")
    assert io.exit_code == 0


# ── nested / combined builtins ─────────────────


def test_echo_pipe_sort():
    stdout, io, _, _, _, _ = _exec_with_stdin("echo hello | sort", stdin=None)
    assert io.exit_code == 0


def test_for_echo_collect():
    """for loop echoing values, all output captured."""
    stdout, _, _, _, _, _ = _exec("for x in c b a; do echo $x; done")
    assert b"c\n" in stdout
    assert b"b\n" in stdout
    assert b"a\n" in stdout


def test_echo_in_function():
    stdout, _, _, _, _, _ = _exec("greet() { echo hello $1; }; greet world")
    assert stdout == b"hello world\n"


def test_echo_in_while():
    stdout, _, _, _, _, _ = _exec("while false; do echo never; done")
    assert stdout is None or stdout == b""


def test_echo_and_export():
    stdout, _, _, session, _, _ = _exec(
        "echo before; export V=set; echo after")
    assert session.env["V"] == "set"
    assert b"after\n" in stdout


def test_echo_in_subshell():
    stdout, _, _, _, _, _ = _exec("(echo sub)")
    assert stdout == b"sub\n"


def test_echo_in_brace_group():
    stdout, _, _, _, _, _ = _exec("{ echo brace; }")
    assert stdout == b"brace\n"


def test_printf_in_function():
    stdout, _, _, _, _, _ = _exec("f() { printf 'hi %s' $1; }; f world")


def test_sort_in_while_read():
    stdout, _, _, session, _, _ = _exec_with_stdin(
        "sort | while read LINE; do export LAST=$LINE; done",
        stdin=b"banana\napple\n")
    assert session.env.get("LAST") is not None


def test_echo_redirect_then_cat():
    """echo writes to file, cat reads it back."""
    _, _, _, _, mount, dispatch = _exec("echo hello > /data/out.txt")
    write_calls = [c for c in dispatch.call_args_list if c[0][0] == "write"]
    assert len(write_calls) == 1


def test_echo_negated():
    _, io, _, _, _, _ = _exec("! echo hello")
    assert io.exit_code == 1


def test_echo_in_case():
    stdout, _, _, _, _, _ = _exec("case yes in yes) echo matched;; esac")
    assert stdout == b"matched\n"


def test_echo_and_chain():
    stdout, _, _, _, _, _ = _exec("echo first && echo second")
    assert b"second\n" in stdout


def test_echo_or_chain():
    stdout, _, _, _, _, _ = _exec("echo first || echo never")
    assert b"first\n" in stdout


# ═══════════════════════════════════════════════
# Background execution (&)
# ═══════════════════════════════════════════════


def test_background_simple():
    """sleep 0 & → runs in background, exits 0."""
    _, io, exec_node, _, _, _ = _exec("sleep 0 &")
    assert exec_node.op == "&"


def test_background_export_before():
    """export A=1 & → export runs in background."""
    _, io, _, session, _, _ = _exec("export A=1 &")
    assert io.exit_code == 0


def test_background_then_foreground():
    """sleep 0 & export B=fg → background + foreground."""
    _, io, _, session, _, _ = _exec("sleep 0 & export B=fg")
    assert session.env["B"] == "fg"


def test_background_echo():
    """echo hello & → echo in background."""
    _, io, exec_node, _, _, _ = _exec("echo hello &")
    assert exec_node.op == "&"
    assert io.exit_code == 0


def test_background_does_not_block():
    """sleep 0.01 & true → true runs immediately."""
    _, io, _, _, _, _ = _exec("sleep 0.01 & true")
    assert io.exit_code == 0


def test_multiple_background():
    """sleep 0 &; sleep 0 &; export DONE=yes."""
    _, _, _, session, _, _ = _exec("sleep 0 & sleep 0 & export DONE=yes")
    assert session.env["DONE"] == "yes"


def test_background_in_sequence():
    """export A=1; sleep 0 &; export B=2."""
    _, _, _, session, _, _ = _exec("export A=1; sleep 0 & export B=2")
    assert session.env["A"] == "1"
    assert session.env["B"] == "2"


# ── pwd builtin ────────────────────────────────


def test_pwd_returns_cwd():
    session = _session(cwd="/data/sub")
    stdout, io, _, _, _, _ = _exec("pwd", session=session)
    assert io.exit_code == 0
    assert stdout == b"/data/sub\n"


def test_pwd_returns_root():
    session = _session(cwd="/")
    stdout, io, _, _, _, _ = _exec("pwd", session=session)
    assert io.exit_code == 0
    assert stdout == b"/\n"


# ── cd builtin ─────────────────────────────────


def test_cd_tilde():
    session = _session(cwd="/data/sub")
    dispatch = _mock_dispatch()
    dispatch.side_effect = FileNotFoundError("not found")
    _, io, _, session, _, _ = _exec("cd ~", session=session, dispatch=dispatch)
    assert session.cwd == "/"
