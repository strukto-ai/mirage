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

import json
from dataclasses import replace
from typing import Any

from mirage.commands.builtin.general.interpreter import run_output
from mirage.commands.builtin.utils.limit import (CommandTimeoutError,
                                                 maybe_with_timeout,
                                                 run_with_timeout)
from mirage.commands.cli.types import CLIInvocation, CLISpec
from mirage.commands.cli.walk import walk
from mirage.commands.config import HELP_OPTION
from mirage.commands.errors import UsageError
from mirage.commands.spec import flag_kwarg_name
from mirage.commands.spec.help import render_help
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, CommandOutput
from mirage.policy import resolve_limit
from mirage.runtime.base import Runtime
from mirage.runtime.policy import runtime_for_language
from mirage.runtime.types import RunArgs, ScriptSource
from mirage.types import PathSpec, Producer, word_text
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.executor.command.run import exec_node
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


def _select_runtime(
        prog: str, leaf: CLISpec,
        entries: list[Runtime]) -> tuple[Runtime | None, str | None]:
    """Pick the workspace entry that runs a script leaf.

    A ``runtime:`` pin names the entry, and the entry must speak the
    script's language, so ``runtime: monty`` on a ``.mjs`` fails loud
    instead of feeding JS to a python interpreter. Without a pin the
    first entry speaking the language serves (runtime_for_language).
    Every refusal names the world so the fix (add or rename an entry)
    is visible.

    Args:
        prog (str): display path for message attribution.
        leaf (CLISpec): the script-bearing node.
        entries (list[Runtime]): the workspace's ordered world.
    """
    script = leaf.script
    if script is None:
        raise RuntimeError(
            f"selecting a runtime for {prog!r} without a script")
    known = ", ".join(repr(entry.name) for entry in entries) or "none"
    if leaf.runtime is not None:
        pinned = next(
            (entry for entry in entries if entry.name == leaf.runtime), None)
        if pinned is None:
            return None, (f"{prog}: unknown runtime: {leaf.runtime!r} "
                          f"(workspace runtimes: {known})")
        if pinned.language != script.language:
            return None, (f"{prog}: runtime {pinned.name!r} does not run "
                          f"{script.language} scripts")
        return pinned, None
    entry = runtime_for_language(entries, script.language)
    if entry is None:
        return None, (f"{prog}: no workspace runtime runs "
                      f"{script.language} scripts "
                      f"(workspace runtimes: {known})")
    return entry, None


async def _script_output(inv: CLIInvocation[Any], script: ScriptSource,
                         runtime: Runtime) -> CommandOutput:
    """Render the invocation onto the selected runtime as one RunArgs.

    The script tier's whole contract, the one a native binary could
    also honor: the program re-parses ``argv`` (the verbatim tokens
    after the head), reads piped stdin, and finds the install's config
    as MIRAGE_CONFIG (JSON) in its environment. The outcome converts
    through the interpreter commands' one mapping (run_output).

    Args:
        inv (CLIInvocation): the line's one invocation record.
        script (ScriptSource): the install's embedded program.
        runtime (Runtime): the selected interpreter entry.
    """
    env = dict(inv.env)
    if inv.config is not None:
        env["MIRAGE_CONFIG"] = json.dumps(inv.config)
    stdin = await materialize(inv.stdin) if inv.stdin is not None else None
    result = await runtime.run(
        RunArgs(code=script.source, args=list(inv.argv), env=env, stdin=stdin))
    return run_output(result)


async def handle_cli(
    install: CLIInstall,
    parts: list[str | PathSpec],
    session: Session,
    stdin: ByteSource | None = None,
    entries: list[Runtime] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute a line whose head word is an installed CLI.

    Dispatch is by NAME: the install resolves the program tree and the
    validated config; no mount is consulted and no operand path picks a
    backend (the one executor divergence from mount commands). The walk
    consumes subcommand words and group options; the leaf's own argv
    rides the ordinary spec machinery because a CLISpec IS a
    CommandSpec. The leaf handler renders the line's one CLIInvocation,
    built here and nowhere else: an fn leaf runs as ``fn(inv)``, a
    script leaf runs its embedded program on a workspace runtime
    (_script_output), so help, usage refusals, and classification all
    happen in front of either tier.

    Args:
        install (CLIInstall): the resolved installation (head word,
            tree, validated config).
        parts (list[str | PathSpec]): expanded command words including
            the head; CLI words are shell-expanded strings.
        session (Session): shell session (cwd for path resolution, env
            for the invocation record).
        stdin (ByteSource | None): stdin data, carried on the
            invocation record.
        entries (list[Runtime] | None): the workspace's ordered
            runtime world, which a script leaf selects its interpreter
            from; None (outside a workspace) refuses script installs.
    """
    # Words re-enter string space as typed (word_text): the walk owns
    # interpretation, so a quoted "Lunch?" must not arrive as the
    # glob-classified absolute /Lunch?. Leaf path operands are resolved
    # later by parse_flags against the session cwd.
    cmd_str = " ".join(word_text(p) for p in parts)
    argv = [word_text(p) for p in parts[1:]]
    stdout: ByteSource | None

    result = walk(install.name, install.spec, argv)
    if result.leaf is None:
        stderr = result.output if result.stream == "stderr" else b""
        stdout = result.output if result.stream == "stdout" else None
        io = IOResult(exit_code=result.exit_code, stderr=stderr)
        return stdout, io, ExecutionNode(command=cmd_str,
                                         exit_code=result.exit_code,
                                         stderr=stderr)

    prog = " ".join((install.name, ) + result.path)
    leaf = result.leaf
    # argparse add_help: every leaf answers --help with its own help
    # unless it declares the flag itself. No injected --version: that is
    # a GNU coreutils convention, not an argparse one.
    parse_spec = leaf
    if not any(option.long == "--help" for option in leaf.options):
        parse_spec = replace(leaf, options=leaf.options + (HELP_OPTION, ))

    parsed = parse_flags(list(result.argv), parse_spec, prog, session.cwd)
    if parsed.flag_kwargs.get("help") is True:
        help_text = render_help(prog, parse_spec).encode()
        return help_text, IOResult(), ExecutionNode(command=cmd_str,
                                                    exit_code=0)

    refusal = option_error(prog, parsed)
    if refusal is not None:
        msg, _code = refusal
        # Leaf usage errors exit 2 (argparse), regardless of the
        # USAGE_EXIT table: prog is an installed name, never a GNU tool
        # with its own pinned exit.
        refusal_io = IOResult(exit_code=2, stderr=msg)
        refusal_node = ExecutionNode(command=cmd_str, exit_code=2, stderr=msg)
        return None, refusal_io, refusal_node

    # Group flags merge into the one bag: ancestor/descendant collisions
    # are a build-time CLISpec error, so a group flag can never shadow a
    # leaf flag.
    kw: dict[str, object] = {
        flag_kwarg_name(spelling): value
        for spelling, value in result.group_flags.items()
    }
    kw.update(parsed.flag_kwargs)
    kw.pop("help", None)

    inv = CLIInvocation(install.config,
                        argv=tuple(argv),
                        paths=tuple(parsed.paths),
                        texts=tuple(parsed.texts),
                        flags=kw,
                        stdin=stdin,
                        env=dict(session.env))

    if leaf.script is not None:
        runtime, refused = _select_runtime(prog, leaf, entries or [])
        if runtime is None:
            # The interpreter is missing, not the command: 127 like an
            # interpreter command no runtime entry captures (run_code).
            sel_stderr = f"{refused}\n".encode()
            sel_io = IOResult(exit_code=127, stderr=sel_stderr)
            return None, sel_io, ExecutionNode(command=cmd_str,
                                               exit_code=127,
                                               stderr=sel_stderr)
        body = _script_output(inv, leaf.script, runtime)
    else:
        fn = leaf.fn
        if fn is None:
            # validate_cli guarantees fn XOR subcommands XOR script and
            # walk only returns handler-bearing nodes as leaf; reaching
            # this is a bug.
            raise RuntimeError(
                f"walk returned a leaf without a handler for {prog!r}")
        body = fn(inv)
    # The leaf's declared limit bounds the handler body and its
    # streams, exactly like mount dispatch: without the wrap a blocking
    # leaf hangs forever and an unbounded-output leaf ignores its own
    # limits.
    limit = resolve_limit(prog, command_default=leaf.limit)
    timeout = limit.timeout_seconds if limit is not None else None
    try:
        out = await run_with_timeout(body, timeout, prog)
    except UsageError as exc:
        # Leaf-raised usage errors (a malformed --json) keep the bare
        # message and exit 2, matching the refusal branch above.
        usage_stderr = f"{exc}\n".encode()
        usage_io = IOResult(exit_code=exc.exit_code, stderr=usage_stderr)
        return None, usage_io, ExecutionNode(command=cmd_str,
                                             exit_code=exc.exit_code,
                                             stderr=usage_stderr)
    except CommandTimeoutError:
        # A limit timeout is answered by the workspace-level handler
        # (exit 124), not here.
        raise
    except Exception as exc:
        # Any other thrown leaf error (an API RuntimeError, a ValueError)
        # becomes this command's IOResult, prefixed like GNU
        # (prog: message), so the rest of the line keeps running.
        err_stderr = f"{prog}: {exc}\n".encode()
        err_io = IOResult(exit_code=1, stderr=err_stderr)
        return None, err_io, ExecutionNode(command=cmd_str,
                                           exit_code=1,
                                           stderr=err_stderr)
    if out is None:
        stdout, io = None, IOResult()
    else:
        stdout, io = out
    io.producer = Producer(command=prog, declared=leaf.limit)

    if parsed.warnings:
        warn = "".join(f"{prog}: {w}\n" for w in parsed.warnings).encode()
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = warn + existing

    stdout = maybe_with_timeout(stdout, limit, prog)
    io.stderr = maybe_with_timeout(io.stderr, limit, prog)

    return stdout, io, await exec_node(cmd_str, io, parsed.paths)
