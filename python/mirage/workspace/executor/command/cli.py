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
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any

from mirage.commands.builtin.general.interpreter import run_output
from mirage.commands.builtin.utils.limit import maybe_with_timeout
from mirage.commands.cli.constants import CLI_CONFIG_ENV, GIT_LONG_OPTIONS
from mirage.commands.cli.refusal import (
    ARGPARSE_EXIT,
    CLAP_EXIT,
    clap_missing_operands,
    directory_refusal,
    leaf_refusal,
)
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.cli.walk import listed_node, node_help, owns_argv, walk
from mirage.commands.config import CommandFnResult, Context
from mirage.commands.spec import flag_kwarg_name
from mirage.commands.spec.flag_view import FlagBag
from mirage.commands.spec.types import (
    Argument,
    CommandSpec,
    FlagValue,
    UsageStyle,
)
from mirage.errors.types import FsCondition
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, CommandOutput
from mirage.policy import resolve_limit
from mirage.process.view import ProcessView
from mirage.runtime.base import Runtime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.routing import runtime_for_language
from mirage.runtime.types import (
    RouteDecision,
    RuntimeIdentity,
    ScriptSource,
    ShellFn,
)
from mirage.runtime.workspace import WorkspaceRuntime
from mirage.shell.bytes import encode_text
from mirage.types import FileType, Limit, PathSpec, Producer, word_text
from mirage.utils.ids import IdSource, SystemIdSource
from mirage.view.types import FollowOperands, SessionView
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.executor.command.handler import (
    answered,
    call_leaf,
    cli_voice,
    run_handler,
)
from mirage.workspace.executor.command.run import (
    admission_denial,
    exec_node,
)
from mirage.workspace.files import Files
from mirage.workspace.mount import MountEntry
from mirage.workspace.mount.namespace.probe import miss_condition, path_stat
from mirage.workspace.session import SessionState, env_snapshot
from mirage.workspace.types import ExecutionNode

# A textual rest operand is a CLI node's pass-through form: parsed under
# unknown_is_operand, it takes the undeclared dashed tokens the node does
# not refuse, which is what a program parsing its own argv needs. "str",
# not "path", so nothing is cwd-resolved or routed. Only that parse
# reads the rest kind this way: a GNU command's textual rest is a list
# of operands, which is why basename has one and still refuses an option
# it does not know.
PASSTHROUGH_REST = Argument("args", nargs="*", metavar="")


def parse_spec_for(
    leaf: CommandSpec,
    style: UsageStyle = UsageStyle.ARGPARSE,
    passthrough: bool = False,
) -> tuple[CommandSpec, bool]:
    """Add help or the script's pass-through grammar before parsing.

    Args:
        leaf (CommandSpec): selected grammar.
        style (UsageStyle): root help dialect.
        passthrough (bool): whether a script owns raw argv.
    """
    if passthrough:
        return replace(
            leaf, arguments=(*leaf.arguments, PASSTHROUGH_REST)
        ), False
    if not leaf.add_help or any(
        "--help" in arg.names for arg in leaf.arguments
    ):
        return leaf, False
    return listed_node(leaf, style), True


def _select_runtime(
    prog: str,
    leaf: CLI,
    entries: list[Runtime[Any]],
    routing: RouteDecision[RuntimeIdentity] | None,
) -> tuple[LanguageRuntime[Any] | None, IOResult | None]:
    """Pick the workspace entry that runs a script leaf.

    A ``runtime:`` pin names the entry, and the entry must speak the
    script's language, so ``runtime: monty`` on a ``.mjs`` fails loud
    instead of feeding JS to a python interpreter. Without a pin the
    program runs where this line runs its language's own interpreter
    (the tier's head word, ``python3`` or ``node``), so the runtime
    capturing that command, or a route policy, places it, and a line
    every capturer refused is refused here too (126). The first entry
    speaking the language serves when the workspace serves that
    interpreter itself (runtime_for_language); a placement on a runtime
    that does not run the script's language is refused like such a
    pin. Every other refusal names the world so the fix (add or rename
    an entry) is visible (127).

    Args:
        prog (str): display path for message attribution.
        leaf (CLI): the script-bearing node.
        entries (list[Runtime]): the workspace's ordered world.
        routing (RouteDecision[Runtime] | None): the line's placement;
            None outside a workspace line, where the first entry
            speaking the language serves.
    """
    script = leaf.script
    if script is None:
        raise RuntimeError(
            f"selecting a runtime for {prog!r} without a script"
        )
    known = ", ".join(repr(entry.name) for entry in entries) or "none"
    chosen: RuntimeIdentity | None
    if leaf.runtime is not None:
        chosen = next(
            (entry for entry in entries if entry.name == leaf.runtime), None
        )
        if chosen is None:
            return None, _missing(
                f"{prog}: unknown runtime: {leaf.runtime!r} "
                f"(workspace runtimes: {known})"
            )
    else:
        entry = runtime_for_language(entries, script.language)
        if entry is None:
            return None, _missing(
                f"{prog}: no workspace runtime runs "
                f"{script.language} scripts "
                f"(workspace runtimes: {known})"
            )
        heads = type(entry).commands
        chosen = (
            routing.bindings.get(heads[0], routing.fallback)
            if routing is not None and heads
            else entry
        )
        if chosen is None:
            return None, admission_denial(prog)
        if isinstance(chosen, WorkspaceRuntime):
            chosen = entry
    if (
        not isinstance(chosen, LanguageRuntime)
        or chosen.language != script.language
    ):
        return None, _missing(
            f"{prog}: runtime {chosen.name!r} does not run "
            f"{script.language} scripts"
        )
    return chosen, None


def _missing(message: str) -> IOResult:
    """The 127 a script CLI answers when no entry can run its program.

    Args:
        message (str): the refusal, naming the world.
    """
    return IOResult(exit_code=127, stderr=encode_text(f"{message}\n"))


async def _script_output(
    config: Any,
    ctx: Context,
    script: ScriptSource,
    runtime: LanguageRuntime[Any],
    prog: str,
    settle: Callable[[Runtime[Any]], Awaitable[None]] | None,
) -> CommandOutput:
    """Render the invocation onto the selected runtime as one ``-c`` run.

    The script tier's whole contract, the one a native binary could
    also honor: the program is named (argv slot 0, so its own messages
    read ``pager:`` and a renamed install names itself), re-parses
    ``argv`` (the verbatim tokens after the head), reads piped stdin,
    and finds the install's config as ``MIRAGE_CLI_CONFIG`` (JSON) in
    its environment. The outcome converts through the interpreter
    commands' one mapping (run_output).

    Args:
        config (Any): the install's config, handed to the program as JSON.
        ctx (Context): the line's context.
        script (ScriptSource): the install's embedded program.
        runtime (Runtime): the selected interpreter entry.
        prog (str): the installed head word, the program's own name.
        settle (Callable | None): settles the runtime once the program
            ends, however it ends.
    """
    env = dict(ctx.env or {})
    if config is not None:
        env[CLI_CONFIG_ENV] = json.dumps(config)
    # A .mjs source needs the engine's module mode, the same bit the
    # js command derives from the operand's extension.
    flags: dict[str, FlagValue] = {"c": script.source, "script_cli": True}
    if script.module:
        flags["module"] = True
    try:
        result = await runtime.execute(
            [],
            list(ctx.argv),
            replace(
                ctx,
                flags=flags,
                env=env,
                spec=(
                    replace(ctx.spec, name=prog)
                    if ctx.spec is not None
                    else CommandSpec(name=prog)
                ),
            ),
        )
    finally:
        if settle is not None:
            await settle(runtime)
    return run_output(result)


@dataclass(frozen=True, slots=True)
class CLIContext:
    """Workspace facts the dispatcher can offer but most CLIs do not
    want: an API client needs no filesystem, while ``git`` is nothing
    but one. Forwarded whole onto the leaf's view, so a leaf that does
    not read them ignores them and there is no allowlist of
    filesystem-aware CLIs to keep in step (the same rule ``links``
    follows for mount commands). Mirrors the TS ``CLIContext``
    (workspace/executor/command/cli.ts).

    Args:
        shell (ShellFn | None): the nested evaluator bound to this
            invocation's session.
        entries (list[Runtime] | None): the workspace's ordered
            runtime world, which a script leaf selects its interpreter
            from; None (outside a workspace) refuses script installs.
        vfs (Files | None): the session's files, run as the line's
            session with the command's gate, for a CLI whose subject is
            files rather than an API.
        session (SessionView | None): the session plane's live, gated
            handle; ``ctx.env`` stays the frozen process view.
        routing (RouteDecision[Runtime] | None): the line's placement, which a
            script leaf runs its program under; None outside a line.
        settle (Callable | None): lands what a script leaf's runtime
            holds and drops the caches its program may have gone past;
            None outside a workspace.
        ids (IdSource): the workspace's source, which the leaf's
            ``ctx.ids`` draws from.
    """

    shell: ShellFn | None = None
    command_limits: Mapping[str, Limit] | None = None
    entries: list[Runtime[Any]] | None = None
    vfs: Files | None = None
    session: SessionView | None = None
    processes: ProcessView | None = None
    routing: RouteDecision[RuntimeIdentity] | None = None
    settle: Callable[[Runtime[Any]], Awaitable[None]] | None = None
    ids: IdSource = field(default_factory=SystemIdSource)


def reaches_service(spec: CLI) -> bool:
    """Whether this CLI reaches a service past the dispatcher.

    Its write verbs then go past the dispatcher's per-path invalidation,
    so the mounts its client may reach drop their caches after one
    (``MountRegistry.drop_caches``). Two roots do that: one with a
    ``config_model`` (an account CLI, initialized from it) and a script
    root, whose config is opaque by construction and whose program may
    reach anything. A root with neither (``git``) has no service to
    reach; its writes go through the dispatcher, which invalidates as it
    goes, so a blanket drop would only cost every other mount a reload.

    Args:
        spec (CLI): the installed root.
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
    uses the shared CommandSpec parser. The leaf gets the line's one
    Context, built here and nowhere else: an fn leaf runs as
    ``fn(accessor, paths, texts, ctx)``, a
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
        stdin (ByteSource | None): stdin data, carried on the context.
        context (CLIContext): the workspace context on offer, one bag
            (the fifth argument TS's ``handleCli`` has always taken).
            Its files, session and processes ride the leaf's ``ctx``; a
            verb that never reads ``ctx.vfs`` cannot touch a mount, and
            outside a workspace it is None.
        drop_caches (Callable | None): drop what the mounts this CLI's
            client may reach keep. Called after a write verb, because an
            account CLI mutates its service by id and no vfs path can be
            derived from that, so per-path invalidation has nothing to
            aim at.
    """
    # Taken before the first await, so a removal racing this line waits
    # for the leaf and its output rather than closing the accessor under
    # them.
    release = install.activity.acquire()
    try:
        stdout, io, node = await _run_cli(
            install, parts, session, stdin, context, drop_caches
        )
        held = None if stdout is None else install.activity.hold(stdout)
        return held, io, node
    finally:
        release()


@dataclass(frozen=True, slots=True)
class LeafCall:
    """A line a command tree's walk resolved to one leaf, parsed and
    ready to run.

    Args:
        cmd_str (str): the line's words as typed, for the record.
        argv (tuple[str, ...]): the words after the head as typed.
        prog (str): the head and the verb path, the name a message, a
            limit and the output guards read.
        path (tuple[str, ...]): the canonical verb path below the head.
        leaf (CommandSpec): the leaf's grammar.
        handler (CLIHandler): the leaf's execution and policy.
        flags (FlagBag[FlagValue]): the group and leaf flags, one bag.
        paths (list[PathSpec]): the path operands, cwd-resolved.
        texts (list[str]): the text operands.
        warnings (list[str]): what the parse warned about, said ahead of
            the leaf's own stderr.
    """

    cmd_str: str
    argv: tuple[str, ...]
    prog: str
    path: tuple[str, ...]
    leaf: CommandSpec
    handler: CLIHandler
    flags: FlagBag[FlagValue]
    paths: list[PathSpec]
    texts: list[str]
    warnings: list[str]


async def walk_leaf(
    name: str,
    cli: CLI,
    parts: list[str | PathSpec],
    session: SessionState,
    vfs: Files | None,
) -> LeafCall | tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Walk a line down a command tree to the leaf it names and parse the
    leaf's words, or answer the line without running anything.

    The walk consumes subcommand words and group options; the leaf's own
    argv uses the shared CommandSpec parser. Help, usage refusals and an
    operand base that is no directory are answered here, for an installed
    CLI and a tree a mount serves alike.

    Args:
        name (str): the head word.
        cli (CLI): the tree.
        parts (list[str | PathSpec]): expanded command words including
            the head; CLI words are shell-expanded strings.
        session (SessionState): shell session (cwd for path resolution,
            env for the parse).
        vfs (Files | None): the session's files, which check an operand
            base; None outside a workspace.
    """
    # Words re-enter string space as typed (word_text): the walk owns
    # interpretation, so a quoted "Lunch?" must not arrive as the
    # glob-classified absolute /Lunch?. Leaf path operands are resolved
    # later by parse_flags against the session cwd.
    cmd_str = " ".join(word_text(p) for p in parts)
    argv = [word_text(p) for p in parts[1:]]

    # The walk takes the same environment the leaf parse below does, so
    # a group-level option declaring ``Argument.env`` fills at its own
    # level; without it the fetched credential never enters group_flags.
    result = walk(
        name,
        cli.spec,
        argv,
        session.cwd,
        env_snapshot(session),
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

    if vfs is not None:
        for base in result.operand_bases:
            info = await path_stat(vfs.dispatch, base)
            if info is not None and info.type is FileType.DIRECTORY:
                continue
            reason = (
                await miss_condition(vfs.dispatch, base)
                if info is None
                else FsCondition.ENOTDIR
            )
            stderr, code = directory_refusal(
                name,
                base.raw_path,
                reason,
                cli.spec.usage_style,
            )
            return (
                None,
                IOResult(exit_code=code, stderr=stderr),
                ExecutionNode(command=cmd_str, exit_code=code, stderr=stderr),
            )

    prog = " ".join((name,) + result.path)
    leaf = result.leaf
    # argparse add_help, minus the two nodes that answer for themselves
    # (parse_spec_for). No injected --version: that is a GNU coreutils
    # convention, not an argparse one.
    parse_spec, mirage_help = parse_spec_for(
        leaf, cli.spec.usage_style, owns_argv(cli)
    )

    # The dialect is the root's, not the leaf's: a program answers in
    # one voice at every level.
    style = cli.spec.usage_style
    # The environment goes into the parse, not on top of it: an option
    # declaring one is coerced, choice-checked, path-resolved and
    # credited against required exactly as a typed value is.
    # git resolves an abbreviated long option against the verb's own full
    # table (parse-options), and its revision walkers take whole words
    # only.
    abbreviations = (
        GIT_LONG_OPTIONS.get(" ".join(result.path), ())
        if cli.spec.name == "git"
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
        msg = clap_missing_operands(
            prog,
            parse_spec,
            parsed.missing_required_operands,
            parsed.typed_dests,
            session.env,
        )
        code = CLAP_EXIT
    elif parsed.missing_required_operands and style is UsageStyle.ARGPARSE:
        usage = node_help(prog, parse_spec, style=style).split("\n", 1)[0]
        names = ", ".join(dict.fromkeys(parsed.missing_required_operands))
        msg = encode_text(
            f"{usage}\n{prog}: error: "
            f"the following arguments are required: {names}\n"
        )
        code = ARGPARSE_EXIT
    if msg is not None:
        refusal_io = IOResult(exit_code=code, stderr=msg or None)
        refusal_node = ExecutionNode(
            command=cmd_str, exit_code=code, stderr=msg
        )
        return shown, refusal_io, refusal_node

    # Group flags merge into the one bag: ancestor/descendant collisions
    # are a build-time CLI error, so a group flag can never shadow a
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
    return LeafCall(
        cmd_str=cmd_str,
        argv=tuple(argv),
        prog=prog,
        path=result.path,
        leaf=leaf,
        handler=cli.handlers[" ".join(result.path)],
        flags=kw,
        paths=list(parsed.paths),
        texts=list(parsed.texts),
        warnings=list(parsed.warnings),
    )


async def handle_mount_cli(
    mount: MountEntry,
    cli: CLI,
    parts: list[str | PathSpec],
    session: SessionState,
    stdin: ByteSource | None = None,
    context: CLIContext = CLIContext(),
    owner: Callable[[str], MountEntry | None] | None = None,
    follow: FollowOperands | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute a line whose head word names a command tree a mount serves.

    The tree a VFS was handed (or one registered on its mount) is walked
    exactly as an installed CLI's is (``walk_leaf``: verbs, help, usage
    refusals, the leaf's parse); the leaf then runs on the mount, on its
    accessor and under its refusals (``MountEntry.run_leaf``), with its
    own limit: the profile's, then the mount's and the workspace's
    entry for the verb path, then the leaf's declared one. A tree runs on
    the mount serving its name, never by operand path, and its leaf keys
    that mount's accessor by each operand: the operands the leaf parse
    resolved are followed through the link table as the router follows a
    mount command's (``follow``), and one another mount holds is refused
    before the leaf runs.

    Args:
        mount (MountEntry): the mount serving the tree, readied.
        cli (CLI): the tree.
        parts (list[str | PathSpec]): expanded command words including
            the head.
        session (SessionState): the session running the line.
        stdin (ByteSource | None): stdin data, carried on the context.
        context (CLIContext): the workspace facts on offer.
        owner (Callable[[str], MountEntry | None] | None): the mount a
            virtual path is on; None checks nothing.
        follow (FollowOperands | None): the router's link resolution for
            this command; None follows nothing.
    """
    walked = await walk_leaf(cli.spec.name, cli, parts, session, context.vfs)
    if not isinstance(walked, LeafCall):
        return walked
    limit = resolve_limit(
        walked.prog,
        command_default=walked.handler.limit,
        mount_override=mount.command_limits.get(walked.prog),
        workspace_limits=context.command_limits,
        profile_limits=session.command_limits,
    )
    paths = walked.paths
    if follow is not None:
        followed = await follow(list(paths))
        paths = [p for p in followed if isinstance(p, PathSpec)]
    foreign = next(
        (
            p
            for p in paths
            if owner is not None
            and p.raw_path != "-"
            and owner(p.virtual) is not mount
        ),
        None,
    )
    if foreign is not None:
        msg = (
            f"{walked.prog}: {foreign.raw_path}: not on {mount.prefix}, "
            f"the mount serving {cli.spec.name}\n"
        ).encode()
        return (
            None,
            IOResult(exit_code=1, stderr=msg),
            ExecutionNode(command=walked.cmd_str, exit_code=1, stderr=msg),
        )

    async def run(ctx: Context) -> CommandFnResult:
        return await mount.run_leaf(
            walked.prog,
            cli,
            walked.handler,
            paths,
            walked.texts,
            ctx,
            limit,
        )

    return await run_walked(walked, session, stdin, context, limit, run)


async def _run_cli(
    install: CLIInstall,
    parts: list[str | PathSpec],
    session: SessionState,
    stdin: ByteSource | None,
    context: CLIContext,
    drop_caches: Callable[[], Awaitable[None]] | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """``handle_cli``'s body, run while the install is held."""
    walked = await walk_leaf(
        install.name, install.cli, parts, session, context.vfs
    )
    if not isinstance(walked, LeafCall):
        return walked
    prog = walked.prog
    binding = walked.handler
    runtime: LanguageRuntime[Any] | None = None
    if install.cli.script is not None:
        runtime, refused = _select_runtime(
            prog, install.cli, context.entries or [], context.routing
        )
        if runtime is None:
            # The interpreter is missing, not the command: 127 like an
            # interpreter command no runtime entry captures (run_code),
            # or 126 when this line's capturers all refused it.
            assert refused is not None
            return (
                None,
                refused,
                ExecutionNode(
                    command=walked.cmd_str,
                    exit_code=refused.exit_code,
                    stderr=await refused.materialize_stderr(),
                ),
            )
    elif binding.fn is None:
        # _validate_cli guarantees fn XOR subcommands XOR script and
        # walk only returns handler-bearing nodes as leaf; reaching
        # this is a bug.
        raise RuntimeError(
            f"walk returned a leaf without a handler for {prog!r}"
        )

    # asyncio's timeout cancels the runtime task as well as the caller;
    # TypeScript forwards an explicit deadline and abort signal instead.
    limit = resolve_limit(
        prog,
        command_default=binding.limit,
        workspace_limits=context.command_limits,
        profile_limits=session.command_limits,
    )

    async def run(ctx: Context) -> CommandFnResult:
        body: Awaitable[CommandOutput]
        if install.cli.script is not None:
            assert runtime is not None
            body = _script_output(
                install.config,
                ctx,
                install.cli.script,
                runtime,
                prog,
                context.settle,
            )
        else:
            assert binding.fn is not None
            body = answered(
                call_leaf(
                    binding.fn,
                    install.accessor,
                    walked.paths,
                    walked.texts,
                    ctx,
                )
            )
        # The leaf's `write` is the one answer: the gate hands it to
        # policy as `CommandContext.write`, and the cache reads it too,
        # so a verb that can mutate (`gh api` under any method) costs
        # the mounts a reload rather than a stale read, and so does one
        # that failed, timed out or was cancelled after its request may
        # have landed.
        return await run_handler(
            body,
            prog,
            limit,
            Producer(command=prog, declared=binding.limit),
            cli_voice(prog),
            drop=drop_caches if binding.write else None,
            frame=install.cli.script is None,
            vfs=ctx.vfs,
        )

    return await run_walked(walked, session, stdin, context, limit, run)


async def run_walked(
    walked: LeafCall,
    session: SessionState,
    stdin: ByteSource | None,
    context: CLIContext,
    limit: Limit | None,
    run: Callable[[Context], Awaitable[CommandFnResult]],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a walked leaf with the one Context a leaf gets, and record it.

    The leaf's declared limit bounds the handler body and its streams,
    exactly like mount dispatch: without the wrap a blocking leaf hangs
    forever and an unbounded-output leaf ignores its own limits. A
    failure the runner framed is recorded as it is; an answer gets the
    parse's warnings ahead of its stderr and the limit's stream guards.

    Args:
        walked (LeafCall): the leaf the walk resolved.
        session (SessionState): the session running the line.
        stdin (ByteSource | None): stdin data, carried on the context.
        context (CLIContext): the workspace facts on offer.
        limit (Limit | None): the resolved limit.
        run (Callable[[Context], Awaitable[CommandFnResult]]): runs the
            leaf's handler with its context.
    """
    active = True

    async def shell(line: str, data: ByteSource | None = None) -> IOResult:
        if not active:
            raise RuntimeError("CLI shell is no longer active")
        if context.shell is None:
            raise RuntimeError("CLI shell is unavailable")
        return await context.shell(line, data)

    # Most CLIs never read the files: an API client has no filesystem,
    # while `git` is nothing but one. None outside a workspace, so a verb
    # that needs them refuses there on its own.
    ctx = Context(
        stdin=stdin,
        flags=walked.flags,
        cwd=PathSpec.from_str_path(session.cwd),
        env=env_snapshot(session),
        argv=walked.argv,
        spec=walked.leaf,
        vfs=context.vfs,
        session=context.session,
        processes=context.processes,
        shell=shell if context.shell is not None else None,
        ids=context.ids,
    )
    try:
        out = await run(ctx)
    finally:
        active = False
    stdout, io = out if out is not None else (None, IOResult())
    if io.producer is None:
        return (
            stdout,
            io,
            ExecutionNode(
                command=walked.cmd_str,
                exit_code=io.exit_code,
                stderr=await io.materialize_stderr(),
            ),
        )

    prog = walked.prog
    if walked.warnings:
        warn = encode_text("".join(f"{prog}: {w}\n" for w in walked.warnings))
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = warn + existing
    stdout = maybe_with_timeout(stdout, limit, prog)
    io.stderr = maybe_with_timeout(io.stderr, limit, prog)
    return stdout, io, await exec_node(walked.cmd_str, io, walked.paths)
