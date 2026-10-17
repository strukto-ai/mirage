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
from collections.abc import Awaitable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Protocol, TypeAlias, overload

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.constants import ROOT_CWD
from mirage.commands.spec import CommandSpec
from mirage.commands.spec.builtins import is_builtin_grammar, registered_spec
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.constants import OWN_OPTION_LOOP
from mirage.commands.spec.standard import help_page, version_line
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, CommandOutput, IOResult
from mirage.process.view import ProcessView
from mirage.runtime.types import (
    DispatchFn,
    ExecPathFn,
    RuntimeIdentity,
    ShellFn,
)
from mirage.types import Limit, PathSpec
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES, make_resolve_glob
from mirage.vfs.constants import DEFAULT_MAX_DU_ENTRIES
from mirage.vfs.types import (
    ChecksumOp,
    ExistsOp,
    FilesContainingOp,
    FirstLinesOp,
    FollowOp,
    IsMountedOp,
    LastLinesOp,
    LineCountOp,
    LinesContainingOp,
    MkdirOp,
    PairOp,
    PathOp,
    PwriteOp,
    ReadBytesOp,
    ReaddirOp,
    ReadRangeOp,
    ReadStreamOp,
    ReadTreeOp,
    ResolveGlobOp,
    RmdirOp,
    RmTreeOp,
    SearchOps,
    SetAttrsOp,
    StatOp,
    TruncateOp,
    WriteOp,
)
from mirage.view.types import (
    FollowOperands,
    LinkTargetStat,
    ReaddirPath,
    SessionAccess,
    SessionView,
    StatPath,
)
from mirage.workspace.files import Files


@dataclass(frozen=True, kw_only=True)
class CommandIO:
    """Backend capabilities consumed by command algorithms.

    Built from a mount's VFS by ``command_io``: each slot is one of its
    functions with the accessor commands still pass in front dropped,
    and a function the VFS does not define is an absent slot. Command
    admission guards these calls; POSIX policy methods belong to the
    filesystem dispatcher and are not part of this interface.

    ``glob_target_stat`` is what a link a glob matched points at,
    resolved through the workspace; the factory stamps it per invocation
    from the session's files, because the adapter is built once per
    backend, and it lets a trailing-slash glob follow a link the way bash
    does. ``glob_follow`` is the line's operand resolution, which a
    typed word's matches take as the names typed would, and
    ``glob_resolved`` is told what each resolution answers, the operands
    the dispatched table warms a command's reads ahead of.
    """

    readdir: ReaddirOp
    read_bytes: ReadBytesOp
    stat: StatOp
    read_stream: ReadStreamOp
    is_mounted: IsMountedOp
    access: SessionAccess | None = None
    read_range: ReadRangeOp | None = None
    exists: ExistsOp | None = None
    write: WriteOp | None = None
    append: WriteOp | None = None
    pwrite: PwriteOp | None = None
    create: PathOp | None = None
    mkdir: MkdirOp | None = None
    unlink: PathOp | None = None
    rmdir: RmdirOp | None = None
    rm_r: RmTreeOp | None = None
    rename: PairOp | None = None
    copy: PairOp | None = None
    dir_copy: PairOp | None = None
    truncate: TruncateOp | None = None
    set_attrs: SetAttrsOp | None = None
    max_glob_matches: int | None = DEFAULT_MAX_GLOB_MATCHES
    max_du_entries: int | None = DEFAULT_MAX_DU_ENTRIES
    search: SearchOps | None = None
    files_containing: FilesContainingOp | None = None
    searchable: tuple[str, ...] | None = None
    lines_containing: LinesContainingOp | None = None
    first_lines: FirstLinesOp | None = None
    last_lines: LastLinesOp | None = None
    line_count: LineCountOp | None = None
    checksum: ChecksumOp | None = None
    follow: FollowOp | None = None
    read_tree: ReadTreeOp | None = None
    glob_target_stat: LinkTargetStat | None = None
    glob_follow: FollowOperands | None = None
    glob_resolved: Callable[[list[PathSpec]], None] | None = None

    @property
    def resolve_glob(self) -> ResolveGlobOp:
        return make_resolve_glob(
            self.readdir,
            self.max_glob_matches,
            self.stat,
            self.glob_target_stat,
            self.access,
            self.glob_follow,
            self.glob_resolved,
        )


@dataclass(frozen=True, slots=True)
class Context:
    """Everything a handler gets besides its handle and its operands.

    A command handler is ``fn(accessor, paths, texts, ctx)`` and a CLI
    leaf ``fn(config, paths, texts, ctx)``: the same ``ctx``, the facts a
    runtime execution takes too. Files are reached through ``vfs``, the
    session's files, which judge every call at the workspace dispatcher,
    as ``session.vfs`` and a policy's ``ctx.vfs`` do. A handler reads the
    fields it needs and ignores the rest; the workspace builds one per
    command or CLI, and ``Mount.run_command`` adds what only the mount
    knows (``mount_prefix``, ``index``, ``io``).

    Args:
        stdin (ByteSource | None): Piped standard input, if any.
        flags (Mapping[str, FlagValue]): The parsed flags. Read them
            through a spec-bound ``FlagView``.
        cwd (PathSpec): The working directory.
        env (dict[str, str] | None): A snapshot of the session
            environment; live access uses ``session``.
        argv (tuple[str, ...]): The words after the head as typed, for a
            diagnostic that quotes one (``cmp: missing operand after
            '-s'``). Empty when a line runs split per operand or per
            mount.
        spec (CommandSpec | None): The resolved grammar.
        vfs (Files | None): The session's files, run as the line's
            session: reads, writes, links, and where the mounts are.
        session (SessionView | None): The live session, with policy
            applied to writes; ``env`` stays the snapshot.
        processes (ProcessView | None): The session's processes.
        shell (ShellFn | None): Run a nested line in the calling
            session, as ``sh -c`` would (awk's pipes and ``system()``).
        access (SessionAccess | None): The calling session's access and
            shell settings.
        mount_prefix (str): The prefix of the mount running the command.
        command (str | None): The command name the mount runs.
        index (IndexCacheStore): The mount's index cache.
        io (CommandIO | None): The mount's backend table, built from its
            VFS; None outside a mount.
        dispatch (DispatchFn | None): The workspace op dispatcher.
        session_id (str | None): The calling session.
        exec_allowed (bool): Whether policy lets the command start an
            interpreter.
        exec_path_allowed (ExecPathFn | None): Whether policy lets an
            interpreter load code from a path; None outside a
            workspace, where ``exec_allowed`` decides.
        runtime (RuntimeIdentity | None): The runtime an interpreter runs
            in.
        runtime_unavailable (str | None): Why the requested runtime is
            missing. Python only; TypeScript refuses earlier.
        follow_operands (FollowOperands | None): The line's pathname
            resolution of its operands, which a glob's matches take as
            typed words would.
        stat_path (StatPath | None): Stat one path through the
            dispatcher, which may land on another mount.
        readdir_path (ReaddirPath | None): List one directory through
            the dispatcher, for a walk that crosses a mount.
    """

    stdin: ByteSource | None = None
    flags: Mapping[str, FlagValue] = field(default_factory=dict)
    cwd: PathSpec = ROOT_CWD
    env: dict[str, str] | None = None
    argv: tuple[str, ...] = ()
    spec: CommandSpec | None = None
    vfs: Files | None = None
    session: SessionView | None = None
    processes: ProcessView | None = None
    shell: ShellFn | None = None
    access: SessionAccess | None = None
    mount_prefix: str = ""
    command: str | None = None
    index: IndexCacheStore = NULL_INDEX
    io: CommandIO | None = None
    dispatch: DispatchFn | None = None
    session_id: str | None = None
    exec_allowed: bool = True
    exec_path_allowed: ExecPathFn | None = None
    runtime: RuntimeIdentity | None = None
    runtime_unavailable: str | None = None
    follow_operands: FollowOperands | None = None
    stat_path: StatPath | None = None
    readdir_path: ReaddirPath | None = None


CommandFnResult = CommandOutput | None
AggregateFn = Callable[[list[tuple[str, bytes]]], Awaitable[bytes]]


class CommandFn(Protocol):
    """A command handler: ``(accessor, paths, texts, ctx)``.

    A handler typed for one backend's accessor is cast to this when it
    is registered.
    """

    def __call__(
        self,
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> Awaitable[CommandFnResult]: ...


@dataclass(frozen=True, slots=True)
class Command:
    """One command as a mount registers it.

    Args:
        name (str): The command name.
        spec (CommandSpec): The grammar, with ``--help`` and
            ``--version`` added.
        vfs (str | None): The backend it belongs to.
        filetype (str | None): The file extension it handles, or None
            for every file.
        fn (CommandFn): The handler.
        aggregate (AggregateFn | None): Merges the results of a run
            split across mounts.
        write (bool): Whether it changes files.
        limit (Limit | None): Its output limit.
        path_guarded (bool): Whether mount-root policy checks its
            operands.
    """

    name: str
    spec: CommandSpec
    vfs: str | None
    filetype: str | None
    fn: CommandFn
    aggregate: AggregateFn | None = None
    write: bool = False
    limit: Limit | None = None
    path_guarded: bool = False

    def with_overrides(self, *, fn: CommandFn) -> "Command":
        """A copy with the handler replaced, to register a customized
        builtin on one mount.

        Args:
            fn (CommandFn): The replacement handler.
        """
        return replace(self, fn=fn)


def _answer_standard_options(
    name: str, spec: CommandSpec, fn: Callable[..., Any]
) -> tuple[CommandSpec, CommandFn]:
    """Add ``--help`` and ``--version`` to a command, as GNU tools have.

    Either one prints to stdout and exits 0 without running the
    handler. A command that declares its own ``--version``, or a
    program that runs its own option loop (OWN_OPTION_LOOP), answers
    that option itself.

    Args:
        name (str): The command name.
        spec (CommandSpec): The declared grammar.
        fn (Callable[..., Any]): The handler.

    Returns:
        tuple[CommandSpec, CommandFn]: The grammar with both options,
            and the handler that answers them.
    """
    own_version = any(
        "--version" in o.names for o in compile_spec(spec).options
    )
    own_help = is_builtin_grammar(name, spec) and name in OWN_OPTION_LOOP
    help_text = help_page(name, spec)
    version_text = version_line(name)

    @functools.wraps(fn)
    async def wrapper(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> CommandFnResult:
        if not own_help and ctx.flags.get("help") is True:
            return yield_bytes(help_text), IOResult()
        if not own_version and ctx.flags.get("version") is True:
            return yield_bytes(version_text), IOResult()
        return await fn(accessor, paths, texts, ctx)

    return registered_spec(name, spec), wrapper


def command(
    name: str,
    *,
    vfs: str | list[str] | None,
    spec: CommandSpec,
    filetype: str | None = None,
    aggregate: AggregateFn | None = None,
    write: bool = False,
    limit: Limit | None = None,
    path_guarded: bool = False,
) -> Callable[..., Any]:
    """Register the decorated handler as a command of one or more VFSes.

    The decorator returns the handler wrapped to answer ``--help`` and
    ``--version``, with one ``Command`` per VFS in its
    ``_registered_commands`` attribute.

    Args:
        name (str): The command name.
        vfs (str | list[str] | None): The VFS name, or several.
        spec (CommandSpec): The command's grammar.
        filetype (str | None): The file extension it handles.
        aggregate (AggregateFn | None): Merges a run split across
            mounts.
        write (bool): Whether it changes files.
        limit (Limit | None): Its output limit.
        path_guarded (bool): Whether mount-root policy checks its
            operands.
    """

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        full_spec, wrapped = _answer_standard_options(name, spec, fn)
        # functools.wraps shares the wrapped function's attribute list,
        # so copy it: wrapping a builtin must not add to its registrations.
        registrations = list(getattr(wrapped, "_registered_commands", []))
        for vfs_name in vfs if isinstance(vfs, list) else [vfs]:
            registrations.append(
                Command(
                    name=name,
                    spec=full_spec,
                    vfs=vfs_name,
                    filetype=filetype,
                    fn=wrapped,
                    aggregate=aggregate,
                    write=write,
                    limit=limit,
                    path_guarded=path_guarded,
                )
            )
        setattr(wrapped, "_registered_commands", registrations)
        return wrapped

    return decorator


CommandSource: TypeAlias = Command | Callable[..., Any]


def registered_commands(
    items: Iterable[CommandSource],
) -> list[Command]:
    """The registrations of *items*, in order.

    Args:
        items (Iterable[CommandSource]): ``Command`` values
            and ``@command``-decorated functions.

    Raises:
        TypeError: An item is neither.
    """
    values: list[Command] = []
    for item in items:
        if isinstance(item, Command):
            values.append(item)
            continue
        registrations = getattr(item, "_registered_commands", None)
        if registrations is None or not all(
            isinstance(r, Command) for r in registrations
        ):
            raise TypeError(
                "a command catalog takes Command values "
                "and @command-decorated functions"
            )
        values.extend(registrations)
    return values


class CommandCatalog(Sequence[Command]):
    """A fixed list of commands, looked up by name and file extension.

    Args:
        items (Iterable[CommandSource]): ``Command`` values
            and ``@command``-decorated functions; a later one wins a
            lookup.
    """

    __slots__ = ("_items", "_by_key")

    def __init__(self, items: Iterable[CommandSource]) -> None:
        self._items = tuple(registered_commands(items))
        self._by_key = {(c.name, c.filetype): c for c in self._items}

    def __len__(self) -> int:
        return len(self._items)

    @overload
    def __getitem__(self, index: int) -> Command: ...

    @overload
    def __getitem__(self, index: slice) -> Sequence[Command]: ...

    def __getitem__(self, index: int | slice) -> Command | Sequence[Command]:
        return self._items[index]

    def __iter__(self) -> Iterator[Command]:
        return iter(self._items)

    def get(self, name: str, filetype: str | None = None) -> Command | None:
        return self._by_key.get((name, filetype))

    def require(self, name: str, filetype: str | None = None) -> Command:
        found = self.get(name, filetype)
        if found is None:
            raise KeyError(
                f"command {name!r} with filetype {filetype!r} "
                "is not registered"
            )
        return found
