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
from mirage.commands.spec.constants import OWN_OPTION_LOOP
from mirage.commands.spec.standard import help_page, version_line
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import NamespaceView, ReaddirPath, SessionView, StatPath
from mirage.process.types import ProcessView
from mirage.runtime.base import Runtime
from mirage.runtime.types import DispatchFn, ExecPathFn, ShellFn
from mirage.types import Limit, PathSpec


@dataclass(frozen=True, slots=True)
class ExecContext:
    """What the workspace hands ``Mount.execute_cmd`` for one command.

    ``execute_cmd`` copies these fields onto ``CommandOpts``, next to
    the facts only the mount knows (``mount_prefix``, ``index``,
    ``filetype_fns``). Each field is named as on ``CommandOpts`` and
    means the same; ``tests/commands/test_exec_context_parity.py``
    pins that.

    Args:
        limit_override (Limit | None): The caller's output limit, which
            ``execute_cmd`` applies itself instead of forwarding.
        cwd (str): The working directory as a virtual path;
            ``execute_cmd`` turns it into a PathSpec.
    """

    limit_override: Limit | None = None
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
    processes: ProcessView | None = None
    shell: ShellFn | None = None
    argv: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CommandOpts:
    """Everything a command handler gets besides its operands.

    ``Mount.execute_cmd`` builds one per invocation and passes it as
    the handler's fourth argument. A handler reads the fields it needs
    and ignores the rest.

    Args:
        stdin (ByteSource | None): Piped standard input, if any.
        flags (Mapping[str, FlagValue]): The parsed flags. Read them
            through a spec-bound ``FlagView``.
        cwd (PathSpec): The working directory.
        mount_prefix (str): The prefix of the mount running the command.
        filetype_fns (Mapping[str, CommandFn] | None): Handlers of the
            same command for one file extension, so a generic can hand
            an operand to one; None inside such a handler.
        command (str | None): The command name the mount runs.
        index (IndexCacheStore): The mount's index cache.
        dispatch (DispatchFn | None): The workspace op dispatcher.
        session_id (str | None): The calling session.
        env (dict[str, str] | None): A snapshot of the session
            environment.
        exec_allowed (bool): Whether policy lets the command start an
            interpreter.
        exec_path_allowed (ExecPathFn | None): Whether policy lets an
            interpreter load code from a path; None outside a
            workspace, where ``exec_allowed`` decides.
        runtime (Runtime | None): The runtime an interpreter runs in.
        runtime_unavailable (str | None): Why the requested runtime is
            missing. Python only; TypeScript refuses earlier.
        ns (NamespaceView | None): What the namespace knows and no
            backend does: symlinks, mount boundaries, the attribute
            overlay.
        stat_path (StatPath | None): Stat one path through the
            dispatcher, which may land on another mount.
        readdir_path (ReaddirPath | None): List one directory through
            the dispatcher, for a walk that crosses a mount.
        session_view (SessionView | None): The live session, with policy
            applied to writes; ``env`` stays the snapshot.
        processes (ProcessView | None): The session's processes.
        shell (ShellFn | None): Run a nested line in the calling
            session, as ``sh -c`` would (awk's pipes and ``system()``).
        argv (tuple[str, ...]): The words after the command name as
            typed, for a GNU diagnostic that quotes one
            (``cmp: missing operand after '-s'``). Empty when a line
            runs split per operand or per mount.
    """

    stdin: ByteSource | None = None
    flags: Mapping[str, FlagValue] = field(default_factory=dict)
    cwd: PathSpec = ROOT_CWD
    mount_prefix: str = ""
    filetype_fns: Mapping[str, "CommandFn"] | None = None
    command: str | None = None
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
    processes: ProcessView | None = None
    shell: ShellFn | None = None
    argv: tuple[str, ...] = ()


CommandFnResult = tuple[ByteSource | None, IOResult] | None
AggregateFn = Callable[[list[tuple[str, bytes]]], Awaitable[bytes]]


class CommandFn(Protocol):
    """A command handler: ``(accessor, paths, texts, opts)``.

    A handler typed for one backend's accessor is cast to this when it
    is registered.
    """

    def __call__(
        self,
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> Awaitable[CommandFnResult]: ...


@dataclass(frozen=True, slots=True)
class RegisteredCommand:
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
        path_guarded (bool): Whether the handler enforces visibility and
            mount restrictions on every path it reaches, including results.
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

    def with_overrides(self, *, fn: CommandFn) -> "RegisteredCommand":
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
    own_version = any(o.long == "--version" for o in spec.options)
    own_help = is_builtin_grammar(name, spec) and name in OWN_OPTION_LOOP
    help_text = help_page(name, spec)
    version_text = version_line(name)

    @functools.wraps(fn)
    async def wrapper(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> CommandFnResult:
        if not own_help and opts.flags.get("help") is True:
            return yield_bytes(help_text), IOResult()
        if not own_version and opts.flags.get("version") is True:
            return yield_bytes(version_text), IOResult()
        return await fn(accessor, paths, texts, opts)

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
    ``--version``, with one ``RegisteredCommand`` per VFS in its
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
        path_guarded (bool): Whether the handler enforces visibility and
            mount restrictions on every path it reaches, including results.
    """

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        full_spec, wrapped = _answer_standard_options(name, spec, fn)
        # functools.wraps shares the wrapped function's attribute list,
        # so copy it: wrapping a builtin must not add to its registrations.
        registrations = list(getattr(wrapped, "_registered_commands", []))
        for vfs_name in vfs if isinstance(vfs, list) else [vfs]:
            registrations.append(
                RegisteredCommand(
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


CommandSource: TypeAlias = RegisteredCommand | Callable[..., Any]


def registered_commands(
    items: Iterable[CommandSource],
) -> list[RegisteredCommand]:
    """The registrations of *items*, in order.

    Args:
        items (Iterable[CommandSource]): ``RegisteredCommand`` values
            and ``@command``-decorated functions.

    Raises:
        TypeError: An item is neither.
    """
    values: list[RegisteredCommand] = []
    for item in items:
        if isinstance(item, RegisteredCommand):
            values.append(item)
            continue
        registrations = getattr(item, "_registered_commands", None)
        if registrations is None or not all(
            isinstance(r, RegisteredCommand) for r in registrations
        ):
            raise TypeError(
                "a command catalog takes RegisteredCommand values "
                "and @command-decorated functions"
            )
        values.extend(registrations)
    return values


class CommandCatalog(Sequence[RegisteredCommand]):
    """A fixed list of commands, looked up by name and file extension.

    Args:
        items (Iterable[CommandSource]): ``RegisteredCommand`` values
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
    def __getitem__(self, index: int) -> RegisteredCommand: ...

    @overload
    def __getitem__(self, index: slice) -> Sequence[RegisteredCommand]: ...

    def __getitem__(
        self, index: int | slice
    ) -> RegisteredCommand | Sequence[RegisteredCommand]:
        return self._items[index]

    def __iter__(self) -> Iterator[RegisteredCommand]:
        return iter(self._items)

    def get(
        self, name: str, filetype: str | None = None
    ) -> RegisteredCommand | None:
        return self._by_key.get((name, filetype))

    def require(
        self, name: str, filetype: str | None = None
    ) -> RegisteredCommand:
        found = self.get(name, filetype)
        if found is None:
            raise KeyError(
                f"command {name!r} with filetype {filetype!r} "
                "is not registered"
            )
        return found
