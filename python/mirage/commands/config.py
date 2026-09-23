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

import functools
from collections.abc import Awaitable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Protocol, cast

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.constants import ROOT_CWD
from mirage.commands.spec import CommandSpec
from mirage.commands.spec.builtin_specs import (HELP_OPTION, VERSION_OPTION,
                                                is_builtin_grammar,
                                                registered_spec)
from mirage.commands.spec.constants import (STANDARD_AFTER_SCAN,
                                            STANDARD_BEFORE_SCAN)
from mirage.commands.spec.help import render_help
from mirage.commands.spec.parser import ParsedArgs, parse_command
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import NamespaceView, ReaddirPath, SessionView, StatPath
from mirage.runtime.base import Runtime
from mirage.runtime.types import DispatchFn, ExecPathFn
from mirage.types import Limit, PathSpec
from mirage.version import __version__


@dataclass(frozen=True, slots=True)
class ExecContext:
    """The execution context ``Mount.execute_cmd`` takes: everything
    the workspace supplies for one invocation beyond the parsed line.

    The one bag a dispatcher call site builds (mirrors the options
    object TypeScript's ``Mount.executeCmd`` has always taken as its
    fifth argument, named ``ExecContext`` there too). ``execute_cmd``
    re-boxes these onto ``CommandOpts`` beside the facts only the mount
    can supply (mount_prefix, index, filetype_fns), so every field here
    is spelled exactly as ``CommandOpts`` spells it — one fact has one
    name on both sides of the seam, pinned by
    ``tests/commands/test_exec_context_parity.py``. ``session_view``
    stays although no ``opts`` reader wants it today, because
    ``CLIDoors.session_view`` has production readers and the doors
    record is pinned to be a subset of ``CommandOpts``.

    Args:
        stdin (ByteSource | None): Piped standard input, if any.
        cwd (str): The session's working directory, as a virtual path;
            ``execute_cmd`` promotes it to the PathSpec handlers read.
        dispatch (DispatchFn | None): The workspace op dispatch.
        session_id (str | None): The calling session.
        env (dict[str, str] | None): The session environment snapshot.
        exec_allowed (bool): Whether the policy layer permits spawning
            an interpreter.
        exec_path_allowed (ExecPathFn | None): Whether code may be
            loaded from one path.
        runtime (Runtime | None): The resolved runtime for interpreter
            commands.
        runtime_unavailable (str | None): Why the requested runtime is
            unavailable (python-only; the TS table refuses at
            resolution time).
        ns (NamespaceView | None): The name plane's facts.
        stat_path (StatPath | None): Dispatcher-backed stat of one path.
        readdir_path (ReaddirPath | None): Dispatcher-backed readdir of
            one path.
        session_view (SessionView | None): The session plane's live,
            gated handle.
    """

    stdin: ByteSource | None = None
    cwd: str = "/"
    dispatch: DispatchFn | None = None
    session_id: str | None = None
    env: dict[str, str] | None = None
    exec_allowed: bool = True
    exec_path_allowed: ExecPathFn | None = None
    runtime: Runtime | None = None
    runtime_unavailable: str | None = None
    ns: NamespaceView | None = None
    stat_path: StatPath | None = None
    readdir_path: ReaddirPath | None = None
    session_view: SessionView | None = None


@dataclass(frozen=True, slots=True)
class CommandOpts:
    """The dispatcher context of one command invocation, as one value.

    Mirrors the TypeScript ``CommandOpts`` (commands/config.ts): the
    dispatcher (``Mount.execute_cmd``) constructs it once and hands it
    to every handler as the fourth argument, so builders and bespoke
    backend wrappers are wiring that passes it through. The generic owns
    everything inside it (flag parsing via a spec-bound FlagView, the
    stdin fallback); the wiring owns everything outside it (glob
    resolution, op binding, push-downs). A handler reads the fields it
    wants and ignores the rest, so there is no opt-in registry anywhere.

    Args:
        stdin (ByteSource | None): Piped standard input, if any.
        flags (Mapping[str, FlagValue]): The parsed command-line flag
            bag — only real flags, no injected context.
        cwd (PathSpec): The session's working directory, promoted by the
            dispatcher — the mount-relative key rides ``vfs_path``
            for operand defaulting. Always a PathSpec (the TS twin keeps
            a string and threads ``mount_prefix`` instead).
        mount_prefix (str): The owning mount's prefix, for commands that
            render mount-relative names.
        filetype_fns (Mapping[str, CommandFn] | None): Extension-specific
            handlers of the same command, for a generic that delegates
            per operand; None when the handler itself is one of them.
        command (str | None): The full command string, set on the
            provision path only.
        spec (CommandSpec | None): The invoked command's spec, set on the
            provision path: a provision function is shared across
            commands, so it needs the spec to resolve a flag spelling.
        index (IndexCacheStore): The mount's index cache store.
        dispatch (DispatchFn | None): The workspace op dispatch, for
            interpreter commands whose sandboxed I/O rides it.
        session_id (str | None): The calling session, for commands that
            record per-session state.
        env (dict[str, str] | None): The session environment.
        exec_allowed (bool): Whether the policy layer permits spawning
            an interpreter.
        exec_path_allowed (ExecPathFn | None): Whether code may be
            loaded from one path, for an interpreter's file operand;
            None outside a workspace, where ``exec_allowed`` answers
            for files too.
        runtime (Runtime | None): The resolved runtime for interpreter
            commands.
        runtime_unavailable (str | None): The hint naming why the
            requested runtime is unavailable. Python-only: the TS
            runtime table refuses at resolution time instead.
        ns (NamespaceView | None): The name plane's facts (symlinks,
            mount boundaries, attr overlay, child names the namespace
            owes a directory), which no backend can see.
        stat_path (StatPath | None): Dispatcher-backed stat of one path,
            for a traversal command's start point.
        readdir_path (ReaddirPath | None): Dispatcher-backed readdir of
            one path, for a walker that reads past a mount boundary.
        session_view (SessionView | None): The session plane's live,
            gated handle (reads and gate-cleared writes); ``env`` above
            stays the frozen process-view snapshot.
    """

    stdin: ByteSource | None = None
    flags: Mapping[str, FlagValue] = field(default_factory=dict)
    cwd: PathSpec = ROOT_CWD
    mount_prefix: str = ""
    filetype_fns: Mapping[str, "CommandFn"] | None = None
    command: str | None = None
    spec: CommandSpec | None = None
    index: IndexCacheStore = NULL_INDEX
    dispatch: DispatchFn | None = None
    session_id: str | None = None
    env: dict[str, str] | None = None
    exec_allowed: bool = True
    exec_path_allowed: ExecPathFn | None = None
    runtime: Runtime | None = None
    runtime_unavailable: str | None = None
    ns: NamespaceView | None = None
    stat_path: StatPath | None = None
    readdir_path: ReaddirPath | None = None
    session_view: SessionView | None = None


CommandFnResult = tuple[ByteSource | None, IOResult] | None


class CommandFn(Protocol):
    """Command handler signature, mirroring the TS ``CommandFn``.

    Four positional parameters — accessor, paths, texts, opts — on both
    sides. Handlers that narrow the accessor to their backend's type are
    cast at registration (``command``), exactly like the TS
    ``options.fn as CommandFn``, so the dispatcher call site stays
    typed.
    """

    def __call__(self, accessor: Accessor, paths: list[PathSpec],
                 texts: list[str],
                 opts: CommandOpts) -> Awaitable[CommandFnResult]:
        ...


class ProvisionFn(Protocol):
    """Provision estimator signature, mirroring the TS ``ProvisionFn``.

    Same four positional parameters as ``CommandFn``; the provision-only
    context (``command``, ``spec``) rides in ``opts``.
    """

    def __call__(self, accessor: Accessor, paths: list[PathSpec],
                 texts: list[str], opts: CommandOpts) -> Awaitable[Any]:
        ...


def version_line(name: str) -> bytes:
    """Render the GNU-style version line for a command.

    Args:
        name (str): command name as invoked.
    """
    return f"{name} (Mirage) {__version__}\n".encode()


def has_injected_version(spec: CommandSpec | None) -> bool:
    """Whether the wrapper supplies this spec's version response.

    Args:
        spec (CommandSpec | None): the registered command spec.
    """
    return spec is not None and any(o is VERSION_OPTION for o in spec.options)


# gnulib's two standard options, in the order ``help_spec`` injects
# them. Both are answered INSIDE the getopt loop, so the one the scan
# reaches FIRST decides the line: measured on coreutils 9.7,
# `cat --help --version` prints the help page and `cat --version --help`
# prints the version line.
_STANDARD_DESTS = ("--help", "--version")


def has_injected_help(spec: CommandSpec | None) -> bool:
    """Whether the wrapper supplies this spec's help response.

    Args:
        spec (CommandSpec | None): the registered command spec.
    """
    return spec is not None and any(o is HELP_OPTION for o in spec.options)


def _scan(name: str, spec: CommandSpec, words: list[str]) -> ParsedArgs:
    """Read these words the way the line is read downstream.

    The same parse, so the two agree by construction rather than by a
    second reading of the grammar. Only the option reports and the typed
    dests are consumed, which is why a cwd the caller does not have is
    not one it needs: nothing here looks at a resolved path.

    Args:
        name (str): command name as invoked, for the per-program rules
            the grammar cannot state.
        spec (CommandSpec): the registered spec.
        words (list[str]): the words to read.
    """
    return parse_command(spec, words, ROOT_CWD.virtual, name)


def _scan_refuses(parsed: ParsedArgs) -> bool:
    """Whether the scan refused an option in the words it read.

    ``missing_required_options`` is deliberately not read: the words are
    a PREFIX of the line for every command but the two that defer, so an
    option declared later has not been reached yet.

    Args:
        parsed (ParsedArgs): one ``_scan`` result.
    """
    return bool(parsed.option_error_kinds
                or parsed.old_option_needs_value is not None)


def _standard_index(name: str, spec: CommandSpec, argv: list[str],
                    dest: str) -> int | None:
    """Where the parser reads one injected standard option, if anywhere.

    Deliberately not a raw scan over argv. A word that only looks like
    the option can be an earlier option's value, and a lookalike stops
    at the wrong one: `grep -e -- --version` hands `--` to -e, so the
    line is not ended and the `--version` after it really is the option,
    while `sort -o --version --version` hands the first spelling to -o's
    output file and only the second is read. Reading each prefix in turn
    puts the answer where the grammar already lives, so `--`, a declared
    remainder and a consumed value all follow from the parser rather
    than from three rules restated here. Adding words never un-types a
    dest, so the first prefix that carries it is the position.

    Args:
        name (str): command name as invoked.
        spec (CommandSpec): the registered spec.
        argv (list[str]): the words after the command name.
        dest (str): canonical long spelling to locate.
    """
    for index in range(len(argv)):
        if dest in _scan(name, spec, argv[:index + 1]).typed_dests:
            return index
    return None


def _standard_output(name: str, spec: CommandSpec, dest: str) -> bytes:
    """What one standard option answers with.

    Args:
        name (str): command name as invoked.
        spec (CommandSpec): the registered spec; ``help_page`` renders
            the same page from it as from the declared one.
        dest (str): canonical long spelling, one of _STANDARD_DESTS.
    """
    return help_page(name, spec) if dest == "--help" else version_line(name)


def standard_request(name: str, spec: CommandSpec | None,
                     argv: list[str]) -> bytes | None:
    """Output when argv asks a command for an injected standard option.

    None when the command declares that option itself, when the parser
    does not read any word as one, or when an option the scan reads
    first is one the parser refuses.

    This is the one door both standard options come through, and it runs
    ahead of routing because neither answer belongs to a backend: `rm
    --version /ro/x` would otherwise meet the read-only refusal, and
    `mv --help /ram/a /disk/b` would otherwise reach the cross-mount
    relay, which bypasses the registered wrapper and MOVED THE FILE. The
    two are one mechanism rather than two because GNU answers both from
    the same long_options table, so they are ordered against each other
    by scan position like any other pair of options: measured on
    coreutils 9.7, `cat --help --version` is the help page and
    `cat --version --help` is the version line.

    Three rules about position, all of them GNU's and none of them
    restated here:

    Which words the scan has read when it answers, because a standard
    option is an option like any other and an error the scan meets first
    is what GNU reports: `cat --bogus --vers` is `unrecognized option
    '--bogus'` (exit 1) and `grep --bogus --vers` is grep's own (exit
    2), where `cat --version --bogus` prints the version and exits 0.
    So the words ahead of the option are re-read through the parser and
    a refusal among them declines the answer. Two families answer
    elsewhere and carry their own tables: STANDARD_AFTER_SCAN finishes
    the whole line first, STANDARD_BEFORE_SCAN answers ahead of every
    option. Both are gated on the spec being the builtin's own grammar,
    since a mount may register a command under one of those names.

    Whether that word is the option at all, which only the parser can
    say: a declared remainder slot is argparse's REMAINDER, so the first
    operand ends option parsing and every later word belongs to the
    program being run; `--` ends it too; and a value-taking option
    swallows the word after it. Asking the parser covers all three.

    And gnulib's ``parse_long_options``, which reads argv[1] only when
    it is the whole line (``argc == 2``), so for a
    SOLE_ARGUMENT_LONG_OPTIONS command the option is an ordinary operand
    as soon as another word joins it (`expr --version` is the version,
    `expr --version x` is `expr: syntax error: unexpected argument
    'x'`). The parser already applies that window, so this reads its
    answer rather than carrying a second copy of the rule.

    Args:
        name (str): command name as invoked.
        spec (CommandSpec | None): the command's registered spec.
        argv (list[str]): the words after the command name.
    """
    if spec is None:
        return None
    injected = {
        "--help": has_injected_help(spec),
        "--version": has_injected_version(spec),
    }
    if not any(injected.values()):
        return None
    whole = _scan(name, spec, argv)
    found: list[tuple[int, str]] = []
    for dest in _STANDARD_DESTS:
        if not injected[dest] or dest not in whole.typed_dests:
            continue
        index = _standard_index(name, spec, argv, dest)
        if index is not None:
            found.append((index, dest))
    if not found:
        return None
    # The one the scan reaches first decides; no two options share a
    # word, so the positions cannot tie.
    index, dest = min(found)
    builtin = is_builtin_grammar(name, spec)
    if builtin and name in STANDARD_BEFORE_SCAN:
        return _standard_output(name, spec, dest)
    # Everything ahead of the option has to scan cleanly: a refusal
    # among those words is what GNU reports instead of the answer.
    if _scan_refuses(_scan(name, spec, argv[:index])):
        return None
    # A program that answers only after the whole scan needs the rest of
    # the line to be clean as well.
    if builtin and name in STANDARD_AFTER_SCAN and _scan_refuses(whole):
        return None
    return _standard_output(name, spec, dest)


def help_page(name: str, spec: CommandSpec) -> bytes:
    """One command's ``--help`` page.

    The page is rendered from ``help_spec``, not from the declared spec,
    so it documents the two options every command answers rather than
    only the ones its author wrote down. Only the builtin itself gets
    GNU's own synopsis line: a registered command that borrowed the name
    keeps the line its own spec synthesizes, which is why this asks for
    the spec OBJECT rather than trusting the name.

    Either form of the builtin's own grammar answers the same page: the
    declared spec the wrapper holds, and the one enriched copy the
    registry parses, which is what a caller reaching this from the
    routing door has. That is exactly what ``is_builtin_grammar``
    settles, and asking it rather than ``SPECS[name] is spec`` is what
    keeps a cross-mount `--help` from losing GNU's synopsis line.

    Args:
        name (str): command name as invoked.
        spec (CommandSpec): the command's grammar, declared or as
            registered.
    """
    synopsis = SYNOPSES.get(name) if is_builtin_grammar(name, spec) else None
    return render_help(name, registered_spec(name, spec),
                       synopsis=synopsis).encode()


def _with_help_support(
        name: str, spec: CommandSpec,
        fn: Callable[..., Any]) -> tuple[CommandSpec, CommandFn]:
    """Inject --help / --version and short-circuit them before the handler.

    Mirrors GNU coreutils: every registered command accepts both flags,
    prints to stdout, and exits 0 without running the command body.
    A command declaring its own --version handles that flag itself.
    """
    has_version = any(o.long == "--version" for o in spec.options)
    new_spec = registered_spec(name, spec)
    help_text = help_page(name, spec)
    version_text = version_line(name)

    @functools.wraps(fn)
    async def wrapper(accessor: Accessor, paths: list[PathSpec],
                      texts: list[str], opts: CommandOpts) -> CommandFnResult:
        if opts.flags.get("help") is True:
            return yield_bytes(help_text), IOResult()
        if not has_version and opts.flags.get("version") is True:
            return yield_bytes(version_text), IOResult()
        return await fn(accessor, paths, texts, opts)

    return new_spec, wrapper


class _Unset:
    __slots__ = ()


_UNSET = _Unset()


@dataclass(frozen=True, slots=True)
class RegisteredCommand:
    name: str
    spec: CommandSpec
    vfs: str | None
    filetype: str | None
    fn: CommandFn
    provision_fn: ProvisionFn | None = None
    aggregate: Callable[..., Any] | None = None
    src: str | None = None
    dst: str | None = None
    write: bool = False
    limit: Limit | None = None

    def with_overrides(
        self,
        *,
        fn: CommandFn | _Unset = _UNSET,
        provision: ProvisionFn | None | _Unset = _UNSET,
    ) -> "RegisteredCommand":
        """Return an independent command definition with selected changes."""
        return replace(
            self,
            fn=(self.fn if fn is _UNSET else cast(CommandFn, fn)),
            provision_fn=(self.provision_fn if provision is _UNSET else cast(
                ProvisionFn | None, provision)),
        )


def command(
    name: str,
    *,
    vfs: str | list[str] | None,
    spec: CommandSpec,
    filetype: str | None = None,
    provision: Callable[..., Any] | None = None,
    dry_run: Callable[..., Any] | None = None,
    aggregate: Callable[..., Any] | None = None,
    write: bool = False,
    limit: Limit | None = None,
) -> Callable[..., Any]:

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        vfs_names = (vfs if isinstance(vfs, list) else [vfs])
        new_spec, wrapped_fn = _with_help_support(name, spec, fn)
        provision_fn = cast(ProvisionFn | None, provision or dry_run)
        # functools.wraps copies function attributes by reference. Copy the
        # registration list before extending it so wrapping a builtin cannot
        # add registrations to the shared backend command.
        cmds = list(getattr(wrapped_fn, "_registered_commands", []))
        for p in vfs_names:
            rc = RegisteredCommand(
                name=name,
                spec=new_spec,
                vfs=p,
                filetype=filetype,
                fn=wrapped_fn,
                provision_fn=provision_fn,
                aggregate=aggregate,
                write=write,
                limit=limit,
            )
            cmds.append(rc)
        setattr(wrapped_fn, "_registered_commands", cmds)
        return wrapped_fn

    return decorator


def cross_command(
    name: str,
    *,
    src: str,
    dst: str,
    spec: CommandSpec,
) -> Callable[..., Any]:

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        rc = RegisteredCommand(
            name=name,
            spec=spec,
            vfs=f"{src}->{dst}",
            filetype=None,
            fn=cast(CommandFn, fn),
            src=src,
            dst=dst,
        )
        cmds = getattr(fn, "_registered_commands", [])
        cmds.append(rc)
        setattr(fn, "_registered_commands", cmds)
        return fn

    return decorator
