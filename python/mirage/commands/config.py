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
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, TypeAlias, overload

from mirage.accessor.base import Accessor
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
from mirage.rs.diff_types import DiffComputer
from mirage.runtime.types import CommandRuntime, ShellFn
from mirage.types import Limit, PathSpec
from mirage.view.types import SessionView
from mirage.workspace.files import Files


@dataclass(frozen=True, slots=True)
class Context:
    """Everything a handler gets besides its handle and its operands.

    A command handler is ``fn(accessor, paths, texts, ctx)`` and a CLI
    leaf too, with the install's accessor: the same ``ctx``, the facts a
    runtime execution takes too. Files are reached through ``vfs``, the
    session's files, which judge every call at the workspace dispatcher,
    as ``session.vfs`` and a policy's ``ctx.vfs`` do; the session through
    ``session``. A handler reads the fields it needs and ignores the rest;
    the workspace builds one per command or CLI, and ``Mount.run_command``
    adds what only the mount knows (``spec``).

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
        spec (CommandSpec | None): The resolved grammar; its ``name`` is
            the command's.
        vfs (Files | None): The session's files, run as the line's
            session: reads, writes, links, and where the mounts are.
        session (SessionView | None): The live session, with policy
            applied to writes; ``env`` stays the snapshot.
        processes (ProcessView | None): The session's processes.
        shell (ShellFn | None): Run a nested line in the calling
            session, as ``sh -c`` would (awk's pipes and ``system()``).
        diff (DiffComputer | None): The workspace's shared diff computation service.
        runtime (CommandRuntime | None): Where an interpreter command
            runs its code, and what policy lets that code start and load.
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
    runtime: CommandRuntime | None = None
    diff: DiffComputer | None = None


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
    """

    name: str
    spec: CommandSpec
    vfs: str | None
    filetype: str | None
    fn: CommandFn
    aggregate: AggregateFn | None = None
    write: bool = False
    limit: Limit | None = None


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
