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
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from typing import Any

from mirage.commands.builtin.general.interpreter import run_output
from mirage.commands.builtin.utils.limit import (
    maybe_with_timeout,
    run_with_timeout,
)
from mirage.commands.cli.constants import CLI_CONFIG_ENV, GIT_LONG_OPTIONS
from mirage.commands.cli.refusal import (
    CLAP_EXIT,
    clap_missing_operands,
    directory_refusal,
    leaf_refusal,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation, CLISpec
from mirage.commands.cli.walk import listed_node, node_help, owns_argv, walk
from mirage.commands.errors import (
    CommandTimeoutError,
    PartialOutputError,
    UsageError,
)
from mirage.commands.spec import flag_kwarg_name
from mirage.commands.spec.flag_view import FlagBag
from mirage.commands.spec.types import FlagValue, Operand, UsageStyle
from mirage.concurrency.limiter import run_blocking
from mirage.errors.types import FsCondition
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, CommandOutput
from mirage.ops.types import NamespaceView, SessionView, StatPath
from mirage.policy import resolve_limit
from mirage.process.view import ProcessView
from mirage.runtime.base import Runtime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.routing import runtime_for_language
from mirage.runtime.types import CodeExecution, DispatchFn, ScriptSource
from mirage.shell.bytes import encode_text
from mirage.types import FileType, Limit, PathSpec, Producer, word_text
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.executor.command.run import exec_node
from mirage.workspace.lookup.lookup import verb_visible
from mirage.workspace.mount.namespace.probe import miss_condition
from mirage.workspace.session import SessionState, env_snapshot
from mirage.workspace.types import ExecutionNode

# A textual rest operand is a CLI node's pass-through form: parsed under
# unknown_is_operand, it takes the undeclared dashed tokens the node does
# not refuse, which is what a program parsing its own argv needs. "str",
# not "path", so nothing is cwd-resolved or routed. Only that parse
# reads the rest kind this way: a GNU command's textual rest is a list
# of operands, which is why basename has one and still refuses an option
# it does not know.
PASSTHROUGH_REST = Operand(type="str")


async def call_leaf(fn: Callable[..., Any], inv: CLIInvocation[Any]) -> Any:
    """Run a leaf handler, whether it was written ``async def`` or not.

    Async handlers run on the workspace loop. Synchronous Python handlers
    run in an owned thread so blocking SDK calls cannot stall the loop.
    Cancellation waits for that thread before releasing the session.

    Args:
        fn (Callable[..., Any]): the leaf's handler.
        inv (CLIInvocation): the one record every leaf receives.
    """
    result = (
        fn(inv)
        if inspect.iscoroutinefunction(fn)
        or inspect.iscoroutinefunction(getattr(fn, "__call__", None))
        else await run_blocking(fn, inv)
    )
    if inspect.isawaitable(result):
        return await result
    return result


def parse_spec_for(
    leaf: CLISpec, style: UsageStyle = UsageStyle.ARGPARSE
) -> tuple[CLISpec, bool]:
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
        style (UsageStyle): the root's voice; argparse also takes ``-h``.

    Returns:
        tuple[CLISpec, bool]: the spec to parse with, and whether the
        injected ``--help`` is mirage's to answer.
    """
    if owns_argv(leaf):
        return replace(leaf, rest=PASSTHROUGH_REST), False
    if any(option.long == "--help" for option in leaf.options):
        return leaf, False
    return replace(leaf, options=listed_node(leaf, style).options), True


def _select_runtime(
    prog: str, leaf: CLISpec, entries: list[Runtime]
) -> tuple[LanguageRuntime | None, str | None]:
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
            f"selecting a runtime for {prog!r} without a script"
        )
    known = ", ".join(repr(entry.name) for entry in entries) or "none"
    if leaf.runtime is not None:
        pinned = next(
            (entry for entry in entries if entry.name == leaf.runtime), None
        )
        if pinned is None:
            return None, (
                f"{prog}: unknown runtime: {leaf.runtime!r} "
                f"(workspace runtimes: {known})"
            )
        if (
            not isinstance(pinned, LanguageRuntime)
            or pinned.language != script.language
        ):
            return None, (
                f"{prog}: runtime {pinned.name!r} does not run "
                f"{script.language} scripts"
            )
        return pinned, None
    entry = runtime_for_language(entries, script.language)
    if entry is None:
        return None, (
            f"{prog}: no workspace runtime runs "
            f"{script.language} scripts "
            f"(workspace runtimes: {known})"
        )
    return entry, None


async def _script_output(
    inv: CLIInvocation[Any],
    script: ScriptSource,
    runtime: LanguageRuntime,
    prog: str,
) -> CommandOutput:
    """Render the invocation onto the selected runtime as one CodeExecution.

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
    result = await runtime.execute(
        CodeExecution(
            language=runtime.language,
            code=script.source,
            args=list(inv.argv),
            prog=prog,
            script_cli=True,
            cwd=inv.cwd,
            env=env,
            stdin=stdin,
            flags=flags,
        )
    )
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
        shell (Callable[[str], Awaitable[IOResult]] | None): the nested
            evaluator bound to this invocation's session.
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

    shell: Callable[[str], Awaitable[IOResult]] | None = None
    command_limits: Mapping[str, Limit] | None = None
    entries: list[Runtime] | None = None
    dispatch: DispatchFn | None = None
    stat_path: StatPath | None = None
    ns: NamespaceView | None = None
    session_view: SessionView | None = None
    processes: ProcessView | None = None


def drops_mount_caches(spec: CLISpec) -> bool:
    """Whether a write verb of this CLI leaves every mount's caches stale.

    A CLI that reaches a service writes past the dispatcher's per-path
    invalidation, so no mount can see the write. Two roots do that: one
    with a ``config_model`` (an account CLI, initialized from it) and a
    script root, whose config is opaque by construction and whose
    program may reach anything. A root with neither (``git``) has no
    service to reach; its writes go through the dispatcher, which
    invalidates as it goes, so a blanket drop would only cost every
    other mount a reload.

    Args:
        spec (CLISpec): the installed root.
    """
    return spec.config_model is not None or spec.script is not None


async def handle_cli(
    install: CLIInstall,
    parts: list[str | PathSpec],
    session: SessionState,
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
        session (SessionState): shell session (cwd for path resolution, env
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
    result = walk(
        install.name,
        install.spec,
        argv,
        session.cwd,
        env_snapshot(session),
        visible=lambda path: verb_visible(install.name, path, session),
    )
    if result.leaf is None:
        stderr = result.output if result.stream == "stderr" else b""
        stdout = result.output if result.stream == "stdout" else None
        io = IOResult(exit_code=result.exit_code, stderr=stderr)
        return (
            stdout,
            io,
            ExecutionNode(
                command=cmd_str, exit_code=result.exit_code, stderr=stderr
            ),
        )

    if stat_path is not None and dispatch is not None:
        for base in result.operand_bases:
            info = await stat_path(base)
            if info is not None and info.type is FileType.DIRECTORY:
                continue
            reason = (
                await miss_condition(dispatch, base)
                if info is None
                else FsCondition.ENOTDIR
            )
            stderr, code = directory_refusal(
                install.name, base.raw_path, reason, install.spec.usage_style
            )
            return (
                None,
                IOResult(exit_code=code, stderr=stderr),
                ExecutionNode(command=cmd_str, exit_code=code, stderr=stderr),
            )

    prog = " ".join((install.name,) + result.path)
    leaf = result.leaf
    # argparse add_help, minus the two nodes that answer for themselves
    # (parse_spec_for). No injected --version: that is a GNU coreutils
    # convention, not an argparse one.
    parse_spec, mirage_help = parse_spec_for(leaf, install.spec.usage_style)

    # The dialect is the root's, not the leaf's: a program answers in
    # one voice at every level.
    style = install.spec.usage_style
    # The environment goes into the parse, not on top of it: an option
    # declaring one is coerced, choice-checked, path-resolved and
    # credited against required exactly as a typed value is.
    # git resolves an abbreviated long option against the verb's own full
    # table (parse-options), and its revision walkers take whole words
    # only.
    abbreviations = (
        GIT_LONG_OPTIONS.get(" ".join(result.path), ())
        if install.spec.name == "git"
        else None
    )
    parsed = parse_flags(
        list(result.argv),
        parse_spec,
        prog,
        session.cwd,
        env=env_snapshot(session),
        unknown_is_operand=True,
        abbreviations=abbreviations,
    )
    if mirage_help and parsed.flag_kwargs.get("help") is True:
        help_text = encode_text(node_help(prog, parse_spec, style=style))
        return (
            help_text,
            IOResult(),
            ExecutionNode(command=cmd_str, exit_code=0),
        )

    refusal = option_error(prog, parsed)
    msg: bytes | None = None
    shown: bytes | None = None
    code = 0
    if refusal is not None:
        msg, code, shown = leaf_refusal(
            style, refusal[0], parsed, " ".join(result.path), leaf
        )
    elif parsed.missing_required_operands and style is UsageStyle.CLAP:
        # Only clap names the empty slots. Under every other style a
        # required operand stays the leaf's own business, worded by the
        # command, which is what every mirage CLI did before this.
        msg = clap_missing_operands(
            prog,
            parse_spec,
            parsed.missing_required_operands,
            parsed.typed_dests,
            session.env,
        )
        code = CLAP_EXIT
    if msg is not None:
        refusal_io = IOResult(exit_code=code, stderr=msg or None)
        refusal_node = ExecutionNode(
            command=cmd_str, exit_code=code, stderr=msg
        )
        return shown, refusal_io, refusal_node

    # Group flags merge into the one bag: ancestor/descendant collisions
    # are a build-time CLISpec error, so a group flag can never shadow a
    # leaf flag.
    kw: FlagBag[FlagValue] = FlagBag(
        {
            flag_kwarg_name(spelling): value
            for spelling, value in result.group_flags.items()
        }
    )
    kw.update(parsed.flag_kwargs)
    if isinstance(parsed.flag_kwargs, FlagBag):
        kw.occurrences.extend(parsed.flag_kwargs.occurrences)
    if mirage_help:
        # Only the injected flag is dropped; a leaf that declared
        # --help itself is handed the value it asked for.
        kw.pop("help", None)

    # One door per state plane, riding the record as one field. Most
    # CLIs never read it: an API client has no filesystem, while `git`
    # is nothing but one. None outside a workspace, so a verb that needs
    # a plane refuses there on its own.
    opened = (dispatch, stat_path, ns, session_view, context.processes)
    doors = (
        CLIDoors(
            dispatch=dispatch,
            stat_path=stat_path,
            ns=ns,
            session_view=session_view,
            processes=context.processes,
        )
        if any(door is not None for door in opened)
        else None
    )
    active = True

    async def shell(command: str) -> IOResult:
        if not active:
            raise RuntimeError("CLI shell is no longer active")
        if context.shell is None:
            raise RuntimeError("CLI shell is unavailable")
        return await context.shell(command)

    inv = CLIInvocation(
        install.config,
        argv=tuple(argv),
        paths=tuple(parsed.paths),
        texts=tuple(parsed.texts),
        cwd=PathSpec.from_str_path(session.cwd),
        flags=kw,
        stdin=stdin,
        env=env_snapshot(session),
        doors=doors,
        spec=leaf,
        shell=shell if context.shell is not None else None,
    )

    # asyncio's timeout cancels the runtime task as well as the caller;
    # TypeScript forwards an explicit deadline and abort signal instead.
    limit = resolve_limit(
        prog,
        command_default=leaf.limit,
        workspace_limits=context.command_limits,
        profile_limits=session.command_limits,
    )
    timeout = limit.timeout_seconds if limit is not None else None
    if leaf.script is not None:
        runtime, refused = _select_runtime(prog, leaf, entries or [])
        if runtime is None:
            # The interpreter is missing, not the command: 127 like an
            # interpreter command no runtime entry captures (run_code).
            sel_stderr = encode_text(f"{refused}\n")
            sel_io = IOResult(exit_code=127, stderr=sel_stderr)
            return (
                None,
                sel_io,
                ExecutionNode(
                    command=cmd_str, exit_code=127, stderr=sel_stderr
                ),
            )
        body = _script_output(
            inv,
            leaf.script,
            runtime,
            prog,
        )
    else:
        fn = leaf.fn
        if fn is None:
            # _validate_cli guarantees fn XOR subcommands XOR script and
            # walk only returns handler-bearing nodes as leaf; reaching
            # this is a bug.
            raise RuntimeError(
                f"walk returned a leaf without a handler for {prog!r}"
            )
        body = call_leaf(fn, inv)
    # The leaf's declared limit bounds the handler body and its
    # streams, exactly like mount dispatch: without the wrap a blocking
    # leaf hangs forever and an unbounded-output leaf ignores its own
    # limits.
    try:
        out = await run_with_timeout(body, timeout, prog)
    except UsageError as exc:
        # Leaf-raised usage errors (a malformed --json) keep the bare
        # message and exit 2, matching the refusal branch above.
        usage_stderr = encode_text(f"{exc}\n")
        usage_io = IOResult(exit_code=exc.exit_code, stderr=usage_stderr)
        return (
            None,
            usage_io,
            ExecutionNode(
                command=cmd_str, exit_code=exc.exit_code, stderr=usage_stderr
            ),
        )
    except CommandTimeoutError:
        # A limit timeout is answered by the workspace-level handler
        # (exit 124), not here. The cancelled leaf may already have sent
        # its request, and a service that accepted it will not roll it
        # back, so the mounts stop trusting their caches now.
        if leaf.write and drop_caches is not None:
            await drop_caches()
        raise
    except Exception as exc:
        # Any other thrown leaf error (an API RuntimeError, a ValueError)
        # becomes this command's IOResult, prefixed like GNU
        # (prog: message), so the rest of the line keeps running, and
        # what a leaf printed before it failed stays printed.
        # The write may already have landed when a leaf throws after its
        # request (a PUT whose --jq program fails filters a response the
        # service already applied); without the drop a github mount keeps
        # serving its pre-write bytes.
        if leaf.write and drop_caches is not None:
            await drop_caches()
        err_stderr = encode_text(f"{prog}: {exc}\n")
        err_io = IOResult(exit_code=1, stderr=err_stderr)
        printed = exc.stdout if isinstance(exc, PartialOutputError) else None
        return (
            printed,
            err_io,
            ExecutionNode(command=cmd_str, exit_code=1, stderr=err_stderr),
        )
    finally:
        active = False
    if out is None:
        stdout, io = None, IOResult()
    else:
        stdout, io = out
    # The spec's `write` is the one answer: what policy calls a write,
    # the cache does too, so a verb that can mutate (`gh api` under any
    # method) costs the mounts a reload rather than a stale read.
    if leaf.write and drop_caches is not None:
        await drop_caches()
    io.producer = Producer(command=prog, declared=leaf.limit)

    if parsed.warnings:
        warn = encode_text("".join(f"{prog}: {w}\n" for w in parsed.warnings))
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = warn + existing

    stdout = maybe_with_timeout(stdout, limit, prog)
    io.stderr = maybe_with_timeout(io.stderr, limit, prog)

    return stdout, io, await exec_node(cmd_str, io, parsed.paths)
