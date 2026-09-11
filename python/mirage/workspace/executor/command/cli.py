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

import inspect
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Any

from mirage.commands.builtin.general.interpreter import run_output
from mirage.commands.builtin.utils.limit import (maybe_with_timeout,
                                                 run_with_timeout)
from mirage.commands.cli.constants import CLI_CONFIG_ENV
from mirage.commands.cli.refusal import (CLAP_EXIT, clap_missing_operands,
                                         leaf_refusal)
from mirage.commands.cli.types import CLIDoors, CLIInvocation, CLISpec
from mirage.commands.cli.walk import owns_argv, walk
from mirage.commands.config import HELP_OPTION
from mirage.commands.errors import CommandTimeoutError, UsageError
from mirage.commands.spec import flag_kwarg_name
from mirage.commands.spec.help import render_help
from mirage.commands.spec.types import FlagValue, Operand, UsageStyle
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, CommandOutput
from mirage.ops.types import NamespaceView, SessionView, StatPath
from mirage.policy import resolve_limit
from mirage.runtime.base import Runtime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.routing import runtime_for_language
from mirage.runtime.types import DispatchFn, RunArgs, ScriptSource
from mirage.types import PathSpec, Producer, word_text
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.executor.command.run import exec_node
from mirage.workspace.session import Session, env_snapshot
from mirage.workspace.types import ExecutionNode

# A textual rest operand is the spec's pass-through form: the parser
# reads undeclared dashed tokens as operands instead of refusing them
# (lenient_dash_operands), which is what a program parsing its own argv
# needs. "str", not "path", so nothing is cwd-resolved or routed.
PASSTHROUGH_REST = Operand(type="str")


async def call_leaf(fn: Callable[..., Any], inv: CLIInvocation[Any]) -> Any:
    """Run a leaf handler, whether it was written ``async def`` or not.

    Deferring the call into this coroutine is what the TypeScript twin
    does with ``(async () => fn(inv))()``: a leaf that returns its
    result directly is awaited like one that returns a coroutine, and
    a leaf that raises synchronously lands in the same catch arms as
    one that raises after an await. Before this a plain ``def`` leaf
    failed at the ``await`` with a TypeError the generic arm rendered
    as ``prog: object tuple can't be used in 'await' expression``.

    Args:
        fn (Callable[..., Any]): the leaf's handler.
        inv (CLIInvocation): the one record every leaf receives.
    """
    result = fn(inv)
    if inspect.isawaitable(result):
        return await result
    return result


def parse_spec_for(leaf: CLISpec) -> tuple[CLISpec, bool]:
    """The spec a leaf's argv parses against, and who answers ``--help``.

    Usually mirage: a leaf declares its grammar, the parser enforces it,
    and ``--help`` is injected the way argparse's add_help does. Two
    nodes answer for themselves instead. A leaf that declares ``--help``
    asked for the flag, so it is delivered rather than intercepted. And
    a script root that declares no grammar (owns_argv) has the whole
    line forwarded: refusing ``--width`` on behalf of a program that
    accepts it would make the tier unusable, since a YAML ``clis:``
    entry cannot declare options at all.

    Args:
        leaf (CLISpec): the resolved leaf node.

    Returns:
        tuple[CLISpec, bool]: the spec to parse with, and whether the
        injected ``--help`` is mirage's to answer.
    """
    if owns_argv(leaf):
        return replace(leaf, rest=PASSTHROUGH_REST), False
    if any(option.long == "--help" for option in leaf.options):
        return leaf, False
    return replace(leaf, options=leaf.options + (HELP_OPTION, )), True


def _select_runtime(
        prog: str, leaf: CLISpec,
        entries: list[Runtime]) -> tuple[LanguageRuntime | None, str | None]:
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
        if (not isinstance(pinned, LanguageRuntime)
                or pinned.language != script.language):
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
                         runtime: LanguageRuntime, prog: str) -> CommandOutput:
    """Render the invocation onto the selected runtime as one RunArgs.

    The script tier's whole contract, the one a native binary could
    also honor: the program is named (argv slot 0, so its own messages
    read ``pager:`` and a renamed install names itself), re-parses
    ``argv`` (the verbatim tokens after the head), reads piped stdin,
    and finds the install's config as ``MIRAGE_CLI_CONFIG`` (JSON) in
    its environment. The outcome converts through the interpreter
    commands' one mapping (run_output).

    Args:
        inv (CLIInvocation): the line's one invocation record.
        script (ScriptSource): the install's embedded program.
        runtime (Runtime): the selected interpreter entry.
        prog (str): the installed head word, the program's own name.
    """
    env = dict(inv.env)
    if inv.config is not None:
        env[CLI_CONFIG_ENV] = json.dumps(inv.config)
    stdin = await materialize(inv.stdin) if inv.stdin is not None else None
    # A .mjs source needs the engine's module mode, the same bit the
    # js command derives from the operand's extension.
    flags = {"module": True} if script.module else {}
    result = await runtime.run(
        RunArgs(code=script.source,
                args=list(inv.argv),
                prog=prog,
                env=env,
                stdin=stdin,
                flags=flags))
    return run_output(result)


@dataclass(frozen=True, slots=True)
class CLIContext:
    """Workspace facts the dispatcher can offer but most CLIs do not
    want: an API client needs no filesystem, while ``git`` is nothing
    but one. Forwarded whole onto the leaf's doors, so a leaf that does
    not read them ignores them and there is no allowlist of
    filesystem-aware CLIs to keep in step (the same rule ``links``
    follows for mount commands). Mirrors the TS ``CLIContext``
    (workspace/executor/command/cli.ts).

    Args:
        entries (list[Runtime] | None): the workspace's ordered
            runtime world, which a script leaf selects its interpreter
            from; None (outside a workspace) refuses script installs.
        dispatch (DispatchFn | None): workspace op dispatcher, for a
            CLI whose subject is files rather than an API.
        stat_path (StatPath | None): dispatcher-backed stat asking both
            channels a backend can answer on.
        ns (NamespaceView | None): the name plane's facts, which no
            backend can see, for a verb that walks a tree itself. The
            mount prefix serving a path is one of them
            (``ns.mounts.root_of``), so it needs no door of its own.
        session_view (SessionView | None): the session plane's live,
            gated handle; ``inv.env`` stays the frozen process view.
    """

    entries: list[Runtime] | None = None
    dispatch: DispatchFn | None = None
    stat_path: StatPath | None = None
    ns: NamespaceView | None = None
    session_view: SessionView | None = None


async def handle_cli(
    install: CLIInstall,
    parts: list[str | PathSpec],
    session: Session,
    stdin: ByteSource | None = None,
    context: CLIContext = CLIContext(),
    drop_caches: Callable[[], Awaitable[None]] | None = None,
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
    (_script_output), so usage refusals, limits, and classification all
    happen in front of either tier. Help too, for every node that
    declared a grammar to render it from (parse_spec_for).

    Args:
        install (CLIInstall): the resolved installation (head word,
            tree, validated config).
        parts (list[str | PathSpec]): expanded command words including
            the head; CLI words are shell-expanded strings.
        session (Session): shell session (cwd for path resolution, env
            for the invocation record).
        stdin (ByteSource | None): stdin data, carried on the
            invocation record.
        context (CLIContext): the workspace context on offer, one bag
            (the fifth argument TS's ``handleCli`` has always taken).
            The four door facts ride ``inv.doors`` as one CLIDoors,
            one door per state plane; a verb that never reads it
            cannot touch a mount, and outside a workspace the field
            is None.
        drop_caches (Callable | None): drop cached listings and bodies
            for the mounts this CLI's service serves. Called after a
            write verb succeeds, because an account CLI mutates its
            service by id and no vfs path can be derived from that, so
            per-path invalidation has nothing to aim at.
    """
    entries = context.entries
    dispatch = context.dispatch
    stat_path = context.stat_path
    ns = context.ns
    session_view = context.session_view
    # Words re-enter string space as typed (word_text): the walk owns
    # interpretation, so a quoted "Lunch?" must not arrive as the
    # glob-classified absolute /Lunch?. Leaf path operands are resolved
    # later by parse_flags against the session cwd.
    cmd_str = " ".join(word_text(p) for p in parts)
    argv = [word_text(p) for p in parts[1:]]
    stdout: ByteSource | None

    # The walk takes the same environment the leaf parse below does, so
    # a group-level option declaring ``Option.env`` fills at its own
    # level; without it the fetched credential never enters group_flags.
    result = walk(install.name, install.spec, argv, session.cwd,
                  env_snapshot(session))
    if result.leaf is None:
        stderr = result.output if result.stream == "stderr" else b""
        stdout = result.output if result.stream == "stdout" else None
        io = IOResult(exit_code=result.exit_code, stderr=stderr)
        return stdout, io, ExecutionNode(command=cmd_str,
                                         exit_code=result.exit_code,
                                         stderr=stderr)

    prog = " ".join((install.name, ) + result.path)
    leaf = result.leaf
    # argparse add_help, minus the two nodes that answer for themselves
    # (parse_spec_for). No injected --version: that is a GNU coreutils
    # convention, not an argparse one.
    parse_spec, mirage_help = parse_spec_for(leaf)

    # The dialect is the root's, not the leaf's: a program answers in
    # one voice at every level.
    style = install.spec.usage_style
    # The environment goes into the parse, not on top of it: an option
    # declaring one is coerced, choice-checked, path-resolved and
    # credited against required exactly as a typed value is.
    parsed = parse_flags(list(result.argv),
                         parse_spec,
                         prog,
                         session.cwd,
                         env=env_snapshot(session))
    if mirage_help and parsed.flag_kwargs.get("help") is True:
        help_text = render_help(prog, parse_spec, style=style).encode()
        return help_text, IOResult(), ExecutionNode(command=cmd_str,
                                                    exit_code=0)

    refusal = option_error(prog, parsed)
    msg: bytes | None = None
    code = 0
    if refusal is not None:
        msg, code = leaf_refusal(style, refusal[0], parsed)
    elif parsed.missing_required_operands and style is UsageStyle.CLAP:
        # Only clap names the empty slots. Under every other style a
        # required operand stays the leaf's own business, worded by the
        # command, which is what every mirage CLI did before this.
        msg = clap_missing_operands(prog, parse_spec,
                                    parsed.missing_required_operands,
                                    parsed.typed_dests, session.env)
        code = CLAP_EXIT
    if msg is not None:
        refusal_io = IOResult(exit_code=code, stderr=msg)
        refusal_node = ExecutionNode(command=cmd_str,
                                     exit_code=code,
                                     stderr=msg)
        return None, refusal_io, refusal_node

    # Group flags merge into the one bag: ancestor/descendant collisions
    # are a build-time CLISpec error, so a group flag can never shadow a
    # leaf flag.
    kw: dict[str, FlagValue] = {
        flag_kwarg_name(spelling): value
        for spelling, value in result.group_flags.items()
    }
    kw.update(parsed.flag_kwargs)
    if mirage_help:
        # Only the injected flag is dropped; a leaf that declared
        # --help itself is handed the value it asked for.
        kw.pop("help", None)

    # One door per state plane, riding the record as one field. Most
    # CLIs never read it: an API client has no filesystem, while `git`
    # is nothing but one. None outside a workspace, so a verb that needs
    # a plane refuses there on its own.
    opened = (dispatch, stat_path, ns, session_view)
    doors = (CLIDoors(dispatch=dispatch,
                      stat_path=stat_path,
                      ns=ns,
                      session_view=session_view) if any(
                          door is not None for door in opened) else None)
    inv = CLIInvocation(install.config,
                        argv=tuple(argv),
                        paths=tuple(parsed.paths),
                        texts=tuple(parsed.texts),
                        flags=kw,
                        stdin=stdin,
                        env=env_snapshot(session),
                        doors=doors)

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
        body = _script_output(inv, leaf.script, runtime, prog)
    else:
        fn = leaf.fn
        if fn is None:
            # validate_cli guarantees fn XOR subcommands XOR script and
            # walk only returns handler-bearing nodes as leaf; reaching
            # this is a bug.
            raise RuntimeError(
                f"walk returned a leaf without a handler for {prog!r}")
        body = call_leaf(fn, inv)
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
        # The write may already have landed when a leaf throws after its
        # request (a PUT whose --jq program fails filters a response the
        # service already applied), and with no IOResult to consult the
        # spec's static answer is the only one left; without the drop a
        # github mount keeps serving its pre-write bytes.
        if leaf.write and drop_caches is not None:
            await drop_caches()
        err_stderr = f"{prog}: {exc}\n".encode()
        err_io = IOResult(exit_code=1, stderr=err_stderr)
        return None, err_io, ExecutionNode(command=cmd_str,
                                           exit_code=1,
                                           stderr=err_stderr)
    if out is None:
        stdout, io = None, IOResult()
    else:
        stdout, io = out
    # The spec's `write` is the static answer, which is the only one most
    # verbs have; a handler that knows better says so on its result, so a
    # read-only `gh api` does not expire every github mount.
    mutated = leaf.write if io.mutated is None else io.mutated
    if mutated and drop_caches is not None:
        await drop_caches()
    io.producer = Producer(command=prog, declared=leaf.limit)

    if parsed.warnings:
        warn = "".join(f"{prog}: {w}\n" for w in parsed.warnings).encode()
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = warn + existing

    stdout = maybe_with_timeout(stdout, limit, prog)
    io.stderr = maybe_with_timeout(io.stderr, limit, prog)

    return stdout, io, await exec_node(cmd_str, io, parsed.paths)
