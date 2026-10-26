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
import dataclasses
import functools
import inspect
import logging
from collections.abc import AsyncIterator, Awaitable, Iterable, Iterator
from contextlib import (
    AbstractAsyncContextManager,
    asynccontextmanager,
    contextmanager,
    nullcontext,
)
from typing import Any, Callable, Literal, TypeVar, cast, overload

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.accessor.ram import RAMAccessor
from mirage.cache.context import publish_read
from mirage.cache.file.io import latest_fingerprint
from mirage.cache.index import NULL_INDEX
from mirage.cache.index.config import IndexConfig, LookupStatus
from mirage.cache.index.factory import build_index
from mirage.cache.index.lock import index_lock
from mirage.cache.index.ram import ListingCheckStore
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.cache.types import WriteContext
from mirage.commands.builtin.utils.limit import (
    run_with_timeout,
    with_pull_timeout,
)
from mirage.commands.builtin.utils.links import dispatch_of, link_view
from mirage.commands.builtin.utils.paths import (
    dispatch_stat,
    link_follow,
    vfs_stat_path,
    virtual_flags,
    virtual_key,
)
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.config import (
    Command,
    CommandFnResult,
    Context,
)
from mirage.commands.spec import CommandSpec
from mirage.commands.spec.constants import (
    STDIN_DASH_COMMANDS,
    STDIN_DASH_LEADING,
)
from mirage.commands.spec.flag_view import FlagBag
from mirage.commands.spec.standard import (
    has_injected_help,
    has_injected_version,
)
from mirage.commands.spec.types import FlagValue
from mirage.context import (
    Caller,
    bind_caller,
    current_caller,
    effective_mount_mode,
    require_paths_writable,
    reset_caller,
    session_visibility,
    strongest_mode_under,
)
from mirage.context.session_context import with_caller
from mirage.core.dev.device import active_pipe, pipe_below
from mirage.core.dev.pipe import DevicePipe
from mirage.core.generic.rewrite import (
    append_by_rewrite,
    expect_offset,
    pwrite_by_rewrite,
    refuse_taken,
    truncate_by_rewrite,
)
from mirage.errors.fs import ebusy, enotdir, enotsup
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.observe.context import (
    RecordingScope,
    active_recorder,
    command_records,
    with_mount_context,
)
from mirage.policy import resolve_limit
from mirage.runtime.python.host.host_io import host_io, with_host_io
from mirage.shell.bytes import encode_text
from mirage.types import (
    FileChangeKind,
    FileStat,
    FileType,
    Limit,
    ListingVersion,
    MountMode,
    PathSpec,
    Producer,
    ReadPolicy,
    ReadSpec,
    SearchQuery,
    WalkProbe,
    WritePolicy,
)
from mirage.utils.activity import Activity
from mirage.utils.clock import Clock
from mirage.utils.filetype import get_extension
from mirage.utils.hidden import path_visible
from mirage.utils.ids import IdSource, SystemIdSource
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import norm
from mirage.utils.ranges import is_unsatisfiable_range, slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.call import declared, declared_calls
from mirage.vfs.constants import WRITE_EFFECTS
from mirage.vfs.types import Effect
from mirage.view.types import StatPath
from mirage.workspace.dispatcher.constants import CALLS
from mirage.workspace.executor.command.handler import (
    answered,
    call_leaf,
    cli_voice,
    mount_voice,
    run_handler,
)
from mirage.workspace.mount.constants import HANDED, STORED_OPS
from mirage.workspace.mount.listing import (
    beyond_window,
    entry_at,
    folder_of,
    index_key,
    keep_listing,
    keep_tree,
    stored_listing,
    stored_stat,
    stored_tree,
    unproven_miss,
)
from mirage.workspace.mount.read_policy import coerce_read_policy
from mirage.workspace.mount.write_policy import (
    coerce_write_policy,
    write_conditions,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")


def _wrap_mount_streams(
    result: tuple[ByteSource | None, IOResult],
    activity: Activity,
) -> tuple[ByteSource | None, IOResult]:
    """Keep the command's caller on the stream in ``result``, so the
    lazy backend body pulled after this frame exits records under the
    mount and reads the revisions its command bound.

    Args:
        result: ``(stream, io)`` as returned by a command handler, inside
            the mount's command scope.
        activity (Activity): the mount's activity, held until the stream
            ends.
    """
    stream, io = result
    if stream is None or isinstance(stream, (bytes, bytearray)):
        return stream, io
    return activity.hold(
        with_caller(with_host_io(stream), current_caller())
    ), io


def _wrap_stream(result: Any, mount_id: str, activity: Activity) -> Any:
    """Hold the host-I/O bypass around an op result that streams.

    An op that returns an async iterator has not run its body yet: the
    backend opens the file on the first ``__anext__``, after the frame
    that called it (and its ``host_io`` scope) is gone. Same reason
    ``_wrap_mount_streams`` re-establishes the recorder state. A result
    may hold something open already (a follow that started its command
    to learn it can), and the wrappers are generators that close nothing
    until they are pulled, so closing the stream closes the result too,
    pulled or not.

    Args:
        result (Any): whatever the op returned.
        mount_id (str): identity of the serving mount.
    """
    if hasattr(result, "__aiter__"):
        return activity.hold(
            OutputStream(
                with_host_io(with_mount_context(result, mount_id)),
                functools.partial(close_quietly, result),
            )
        )
    return result


@functools.cache
def _parameters(fn: Callable[..., Any]) -> frozenset[str] | None:
    """The keyword names ``fn`` takes, None when it takes any.

    Args:
        fn (Callable[..., Any]): an unbound function.
    """
    params = inspect.signature(fn).parameters.values()
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params):
        return None
    return frozenset(
        p.name
        for p in params
        if p.kind
        in (
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        )
    )


def _taken(
    name: str, fn: Callable[..., Any], kwargs: dict[str, Any]
) -> dict[str, Any]:
    """The keywords of ``kwargs`` that ``fn`` takes.

    The mount hands every function its ``index``, and a walk hands a
    listing its ``limit``; a function that does not name either never
    sees it, and one that takes any keyword is handed ``limit`` only by
    name, so a plug-in passing its keywords on to another listing is not
    handed a hint that one refuses. Every other keyword is the caller's,
    and one the function does not take is the TypeError a direct call
    would raise, never silently dropped.

    Args:
        name (str): the function the caller named, which the error names.
        fn (Callable[..., Any]): the function about to run.
        kwargs (dict[str, Any]): the call's keywords.
    """
    bound = fn.func if isinstance(fn, functools.partial) else fn
    target = getattr(bound, "__func__", bound)
    names = _parameters(target)
    listing = name in ("readdir", "read_tree")
    if names is None:
        named = "limit" in inspect.signature(target).parameters
        return {
            k: v
            for k, v in kwargs.items()
            if not listing or k != "limit" or named
        }
    exempt = {"index", "limit"} if listing else {"index"}
    unknown = sorted(set(kwargs) - names - exempt)
    if unknown:
        raise TypeError(
            f"{name}() got an unexpected keyword argument {unknown[0]!r}"
        )
    return {k: v for k, v in kwargs.items() if k in names}


def _wants(fn: Callable[..., Any]) -> frozenset[str]:
    """The stats ``fn`` declares it is handed (``HANDED``).

    Args:
        fn (Callable[..., Any]): a backend function.
    """
    target = fn.func if isinstance(fn, functools.partial) else fn
    names = _parameters(getattr(target, "__func__", target))
    return frozenset() if names is None else names & HANDED


def _takes_index(fn: Callable[..., Any]) -> bool:
    """Whether a backend function takes the mount's index, to answer a
    fresh check itself.

    Args:
        fn (Callable[..., Any]): the backend function.
    """
    target = fn.func if isinstance(fn, functools.partial) else fn
    names = _parameters(getattr(target, "__func__", target))
    return names is None or "index" in names


def _handed_on(
    fn: Callable[..., Any], index: IndexCacheStore, **stats: FileStat | None
) -> dict[str, Any]:
    """The keywords a mount wrapper passes on to the backend function it
    wraps: its index where it takes one, and each stat it declares that
    was found.

    Args:
        fn (Callable[..., Any]): the backend function.
        index (IndexCacheStore): the mount's index.
        **stats (FileStat | None): the stats the mount resolved.
    """
    target = fn.func if isinstance(fn, functools.partial) else fn
    names = _parameters(getattr(target, "__func__", target))
    handed: dict[str, Any] = {
        name: stat
        for name, stat in stats.items()
        if stat is not None and (names is None or name in names)
    }
    if names is None or "index" in names:
        handed["index"] = index
    return handed


async def _tree_root(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> CommandFnResult:
    """A command tree's root, which never runs: the executor walks the
    tree and runs the leaf the line names (``MountEntry.run_leaf``).

    Args:
        accessor (Accessor): the mount's accessor.
        paths (list[PathSpec]): path operands.
        texts (list[str]): text operands.
        ctx (Context): the command's context.
    """
    name = ctx.spec.name if ctx.spec is not None else "?"
    raise RuntimeError(f"{name}: a command tree runs the leaf its walk names")


def _tree_command(cli: CLI) -> Command:
    """The command a mount registers for a command tree: its root, under
    the tree's name.

    The tree runs on the mount's accessor, so it declares none of an
    installation's own: no config, no accessor, no script, no runtime.

    Args:
        cli (CLI): the tree.

    Raises:
        ValueError: The tree declares an installation's own setting.
    """
    name = cli.spec.name
    for setting, own in (
        ("config_model", cli.config_model is not None),
        ("accessor", cli.accessor is not NOOPAccessor),
        ("script", cli.script is not None),
        ("runtime", cli.runtime is not None),
    ):
        if own:
            raise ValueError(
                f"cli {name!r}: a command tree on a mount runs on the "
                f"mount's accessor; it cannot declare {setting}"
            )
    return Command(
        name=name,
        spec=cli.spec,
        vfs=None,
        filetype=None,
        fn=_tree_root,
        write=any(handler.write for handler in cli.handlers.values()),
    )


def _named_spec(cmd: Command, cmd_name: str) -> CommandSpec:
    """The grammar a handler sees at ``ctx.spec``, named for the command
    it runs as (python3 or python, js or node).

    Args:
        cmd (Command): the handler about to run.
        cmd_name (str): the command name the mount runs.
    """
    if cmd.spec.name == cmd_name:
        return cmd.spec
    return dataclasses.replace(cmd.spec, name=cmd_name)


async def _as_stream(
    answer: Awaitable[ByteSource] | AsyncIterator[bytes],
) -> AsyncIterator[bytes]:
    """A backend read's answer as a stream: a coroutine awaited on the
    first pull, a stream passed through, bytes as one chunk.

    Args:
        answer (Awaitable[ByteSource] | AsyncIterator[bytes]): what
            calling ``read`` returned.
    """
    found = await answer if inspect.isawaitable(answer) else answer
    if isinstance(found, bytes):
        if found:
            yield found
        return
    try:
        async for chunk in found:
            yield chunk
    finally:
        await close_quietly(found)


async def _collected(
    answer: Awaitable[ByteSource] | AsyncIterator[bytes],
    path: PathSpec,
    whole: bool,
    clock: Clock,
) -> bytes:
    """A backend read's answer as bytes, a stream collected.

    A whole read's stream publishes the version it recorded for the bytes
    collected from it, as a whole read answering bytes publishes its own,
    so a read-modify-write still sends the version it read. Its records
    are its own, so a read running beside it never lends it a version,
    and reach the block around it too, so the write a rewrite makes still
    sees the read that proves the copy it extends.

    Args:
        answer (Awaitable[ByteSource] | AsyncIterator[bytes]): what
            calling ``read`` returned.
        path (PathSpec): the file read.
        whole (bool): whether the read is of the whole file.
        clock (Clock): the workspace clock a read outside a line records
            on.
    """
    found = await answer if inspect.isawaitable(answer) else answer
    if isinstance(found, bytes):
        return found
    if not whole:
        return await materialize(found)
    held = current_caller().command_sink
    outer = held[1] if held is not None and held[1] is not held[0] else None
    scope = RecordingScope(active=active_recorder() is None, clock=clock)
    try:
        with command_records() as records:
            try:
                data = await materialize(found)
            finally:
                if outer is not None:
                    outer.extend(records)
    finally:
        scope.close()
    publish_read(path.virtual, data, latest_fingerprint(records, path.virtual))
    return data


async def _read_window(
    read: Callable[..., Awaitable[ByteSource] | AsyncIterator[bytes]],
    ranges: bool,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
    entry: FileStat | None = None,
    parent: FileStat | None = None,
) -> bytes:
    """A read, honoring a byte window when one is asked for.

    A VFS that reads ranges natively fetches only the window, which is
    the whole point on an object store: one ranged GET instead of the
    whole file. Every other read is whole and sliced, which is the only
    meaningful behavior for content that is rendered rather than stored.
    A zero-length read is answered here rather than sent anywhere, and a
    window starting at or past EOF answers empty, the POSIX answer, where
    an HTTP store refuses with 416: normalizing here keeps the op's
    contract one thing whichever path answers it.

    Args:
        read (Callable[..., Awaitable[ByteSource] | AsyncIterator[bytes]]):
            the VFS's read, or the renderer for the path's filetype.
        ranges (bool): whether ``read`` takes a window natively.
        path (PathSpec): the file.
        index (IndexCacheStore): the mount's index.
        offset (int): the window's first byte.
        size (int | None): the window's length, None through the end.
        entry (FileStat | None): what is at ``path``, for a ``read`` that
            declares it; None hands nothing.
        parent (FileStat | None): what is at the folder holding
            ``path``, for a ``read`` that declares it; None hands nothing.
    """
    if size == 0:
        return b""
    whole = not offset and size is None
    handed = _handed_on(read, index, entry=entry, parent=parent)
    if ranges and not whole:
        try:
            return await _collected(
                read(path, offset=offset, size=size, **handed),
                path,
                False,
                index.clock,
            )
        except Exception as exc:
            if not is_unsatisfiable_range(exc):
                raise
            return b""
    data = await _collected(read(path, **handed), path, True, index.clock)
    if whole:
        return data
    return slice_window(data, offset, size)


class MountEntry:
    """A mounted VFS with command and op dispatch.

    Each mount has its own lookup tables for commands and ops.
    Different mounts of the same VFS type can have
    different registered commands/ops.

    Resolution hierarchy (same for commands and ops):
    1. (name, extension) -- filetype-specific
    2. (name, None) -- VFS-specific
    3. general[name] -- general fallback
    """

    def __init__(
        self,
        prefix: str,
        vfs: BaseVFS,
        mode: MountMode = MountMode.READ,
        read: ReadSpec | None = None,
        index: IndexCacheStore | None = None,
        vfs_ref: str | None = None,
        index_config: IndexConfig | None = None,
        write: WritePolicy | str | None = None,
        ids: IdSource | None = None,
    ) -> None:
        if not prefix.startswith("/"):
            raise ValueError(f"prefix must start with /: {prefix!r}")
        if not prefix.endswith("/"):
            raise ValueError(f"prefix must end with /: {prefix!r}")
        if "//" in prefix:
            raise ValueError(f"prefix must not contain //: {prefix!r}")
        for filetype, renderer in vfs.renderers.items():
            if not callable(getattr(vfs, renderer, None)):
                raise TypeError(
                    f"{type(vfs).__name__}.renderers maps {filetype!r} to "
                    f"{renderer!r}, which is not a method"
                )
        self.visible: Callable[[str | None], bool] | None = None
        self.mount_id = (ids if ids is not None else SystemIdSource()).uuid7()
        self.prefix = prefix
        self.vfs = vfs
        # The functions the VFS answers itself, read once when it is
        # mounted: each dispatcher call it defines, its own ``@vfs_call``
        # functions among them, and ``read_range`` when a read fetches only
        # the range asked for. A command asks its mount's row
        # (``MountView.answers``).
        self.calls = frozenset(
            name
            for name in {*CALLS, *declared_calls(type(vfs))}
            if vfs.supports(name)
        ) | ({"read_range"} if vfs.reads_ranges else set())
        self.mode = mode
        # How this mount's cached bytes are revalidated. Read by the
        # gate (Reconciler.may_serve_cached) and by the cache write path
        # for its bound.
        #
        # Normalized here, where a spec becomes live mount state, because
        # `ReadPolicy` is a (str, Enum) and `ReadSpec` coerces nothing:
        # an embedder writing `ReadSpec(policy="fresh")` against the
        # public API would otherwise store the bare string, and every
        # reader compares with `is` -- the verdict, the gate, the routing
        # reconcile -- so the mount would pass its capability check and
        # then behave as `bounded` everywhere. That is the silent
        # downgrade the policy exists to remove, so it is refused rather
        # than kept. The TypeScript twin freezes its copy at the same
        # point for the mirror-image reason.
        spec = read if read is not None else ReadSpec()
        self.read = dataclasses.replace(
            spec, policy=coerce_read_policy(spec.policy)
        )
        # What the client keeps of its own (a store's search results) is
        # served under the same policy.
        vfs.accessor.govern(self.read)
        # Coerced so an embedder's bare string still matches `is`.
        self.write = coerce_write_policy(write)
        # The store this mount runs its driver under, built by the
        # registry when the driver is placed and shared with any alias
        # of the same instance; a bare entry gets a RAM store at the
        # driver's TTL. ``index`` is the same store scoped by the cache
        # manager, which is what ops and commands receive.
        self.index_store: IndexCacheStore = (
            index if index is not None else build_index(None, vfs.index_ttl)
        )
        # The ``vfs:`` value the driver was built from, recorded for
        # snapshots; None for one constructed in code.
        self.vfs_ref = vfs_ref
        self.index_config = (
            index_config.model_copy(deep=True)
            if index_config is not None
            else None
        )
        self.activity = Activity()
        self.retiring = False
        self.before_use: Callable[[], Awaitable[None]] | None = None
        self._ready_lock = asyncio.Lock()
        self.cache_manager: CacheManager | None = None
        # Per-path revision pins installed at Workspace.load time. Read
        # functions consult these via the ``revision_for`` contextvar
        # lookup; on a hit, the backend GET pins to the recorded
        # revision so replay serves the exact bytes the agent saw.
        # Empty during normal runs; populated only by the snapshot
        # loader.
        self.revisions: dict[str, str] = {}
        self._cmds: dict[tuple[Any, ...], Command] = {}
        # The (name, filetype) keys a user command holds: one registered
        # through ``register`` or ``register_commands`` rather than one of
        # mirage's own, which the registry registers privately.
        self._user_keys: set[tuple[Any, ...]] = set()
        self._general_cmds: dict[str, Command] = {}
        # name -> (the root command registered, the tree it walks)
        self._trees: dict[str, tuple[Command, CLI]] = {}
        self._cmd_specs: dict[str, CommandSpec] = {}
        # first token -> descending token counts of multi-word command
        # names (e.g. "gws docs documents get"); backs longest-prefix
        # command resolution. None until first built; invalidated on
        # register.
        self._prefix_index: dict[str, list[int]] | None = None
        self.command_limits: dict[str, Limit] = {}
        # key: (cmd_name, target_resource_type)

    @asynccontextmanager
    async def use(self) -> AsyncIterator[None]:
        await self.ensure_ready()
        if self.retiring:
            raise ebusy(self.prefix)
        release = self.activity.acquire()
        try:
            yield
        finally:
            release()

    def answers(self, name: str) -> bool:
        """Whether this mount answers the op ``name``.

        Args:
            name (str): the op name.
        """
        return bool(self._callers(name, None))

    @property
    def index(self) -> IndexCacheStore:
        return (
            self.cache_manager.scope_index()
            if self.cache_manager
            else self.index_store
        )

    async def ensure_ready(self) -> None:
        """Finish mount preparation before any backend or cache read."""
        if self.retiring:
            raise ebusy(self.prefix)
        if self.before_use is None:
            return
        async with self._ready_lock:
            if self.before_use is not None:
                await self.before_use()
                self.before_use = None
        if self.retiring:
            raise ebusy(self.prefix)

    def effective_mode(self) -> MountMode:
        """This mount's mode narrowed by the current session's cap.

        The configured mode is the ceiling; a session's mode can only
        weaken it.
        """
        return effective_mount_mode(self.prefix, self.mode)

    # ── command registration ──────────────────────────

    def register(self, cmd: Command) -> None:
        """Register a user command for this mount's VFS.

        Args:
            cmd (Command): the command.
        """
        self._put(cmd)
        self._user_keys.add((cmd.name, cmd.filetype))

    def _put(self, cmd: Command) -> None:
        """Hold ``cmd`` under its name and filetype.

        Args:
            cmd (Command): the command.
        """
        key = (cmd.name, cmd.filetype)
        self._cmds[key] = cmd
        if cmd.spec is not None:
            self._cmd_specs[cmd.name] = cmd.spec
        self._prefix_index = None

    def _register_builtins(self, fns: Iterable[Any]) -> None:
        """Register mirage's own commands for this mount's VFS (a builtin
        backend's command module), which run as builtins: the dispatcher
        gates each write they make, in their own GNU voice.

        Args:
            fns (iterable): Decorated functions or Command values.

        Raises:
            ValueError: If a command's VFS doesn't match this mount's VFS.
        """
        commands, _trees = self._accepted(fns)
        for rc in commands:
            self._put(rc)
            self._user_keys.discard((rc.name, rc.filetype))

    def _is_user_command(self, cmd: Command) -> bool:
        """Whether ``cmd`` is a user command: one a VFS was handed
        (``vfs.commands()``) or one registered later
        (``ws.mount(p).register_commands``), rather than mirage's own.

        Args:
            cmd (Command): the handler about to run.
        """
        key = (cmd.name, cmd.filetype)
        return key in self._user_keys and self._cmds.get(key) is cmd

    def register_general(
        self,
        cmd: Command,
    ) -> None:
        """Register a command every mount shares (vfs=None).

        The generic coreutils and the general commands (e.g. echo, pwd)
        work on any VFS. They are the last fallback in resolve_command().
        """
        self._general_cmds[cmd.name] = cmd
        if cmd.spec is not None:
            self._cmd_specs[cmd.name] = cmd.spec
        self._prefix_index = None

    def resolve_command(
        self,
        cmd_name: str,
        extension: str | None = None,
    ) -> Command | None:
        """Resolve command with fallback hierarchy.

        Lookup order:
        1. (cmd_name, extension) -- filetype-specific
        2. (cmd_name, None) -- VFS-specific
        3. general_cmds[cmd_name] -- the generic and general commands
           every mount shares
        4. any filetype variant, so a caller without an extension still
           finds a command registered only for some filetypes;
           run_command picks the handler from the operand
        """
        if extension:
            cmd = self._cmds.get((cmd_name, extension))
            if cmd is not None:
                return cmd
        cmd = self._cmds.get((cmd_name, None))
        if cmd is not None:
            return cmd
        cmd = self._general_cmds.get(cmd_name)
        if cmd is not None:
            return cmd
        for (name, _filetype), rc in self._cmds.items():
            if name == cmd_name:
                return rc
        return None

    def may_write(
        self,
        cmd_name: str,
        extension: str | None = None,
        builtins: bool = True,
    ) -> bool:
        """Whether a run of ``cmd_name`` on an operand with ``extension``
        can reach a handler that declares it may write.

        Every handler the run's cascade tries counts, the filetype one
        first, since one that declines hands the run to the next. The
        directory probe a run makes (``_pick_handlers``) is not made, so
        a directory named like a file counts its filetype handler too.

        Args:
            cmd_name (str): command name.
            extension (str | None): the operand's extension; None for
                none.
            builtins (bool): whether mirage's own handlers count; False
                when the line's options leave them nothing to write
                (``changes_files``). A user command counts either way.
        """
        return any(
            cmd.write and (builtins or self._is_user_command(cmd))
            for cmd in self._resolve_cascade(
                cmd_name, extension, self._cmds, self._general_cmds
            )
        )

    def longest_command_match(self, words: list[str]) -> int:
        """How many leading words form a registered command name here.

        Command names may span several words (``gws docs documents
        get``), git-style. Returns the length of the longest registered
        name that is a prefix of ``words``, or 1 (the bare first token) if
        no multi-word name matches. 0 for no words.

        Args:
            words (list[str]): expanded leading words of a command line.
        """
        if not words:
            return 0
        if self._prefix_index is None:
            index: dict[str, set[int]] = {}
            names = (
                set(self._cmd_specs)
                | {n for n, _ in self._cmds}
                | set(self._general_cmds)
            )
            for name in names:
                tokens = name.split(" ")
                if len(tokens) > 1:
                    index.setdefault(tokens[0], set()).add(len(tokens))
            self._prefix_index = {
                k: sorted(v, reverse=True) for k, v in index.items()
            }
        for length in self._prefix_index.get(words[0], ()):
            if (
                length <= len(words)
                and self.resolve_command(" ".join(words[:length])) is not None
            ):
                return length
        return 1

    def spec_for(
        self,
        cmd_name: str,
    ) -> CommandSpec | None:
        """Get the spec for a command name."""
        return self._cmd_specs.get(cmd_name)

    def all_commands(self) -> list[Command]:
        """All registered commands (per-mount + general), deduped by name."""
        seen: set[str] = set()
        out: list[Command] = []
        for rc in self._cmds.values():
            if rc.name in seen:
                continue
            seen.add(rc.name)
            out.append(rc)
        for rc in self._general_cmds.values():
            if rc.name in seen:
                continue
            seen.add(rc.name)
            out.append(rc)
        return out

    def register_commands(self, fns: Iterable[Any]) -> None:
        """Register decorated functions, command definitions or command
        trees as user commands.

        A user command reaches its backend through its own handle, past
        the dispatcher, so it does not run while the session restricts
        this mount, and a write command is refused before it runs on a
        read-only one. A ``CLI`` serves its verbs as a command tree on
        this mount, under its root's name: a line naming it walks the
        tree as an installed CLI's does and runs the leaf on this mount's
        accessor (``run_leaf``).

        Args:
            fns (iterable): Decorated functions, Command values or CLI
                trees.

        Raises:
            ValueError: If a command's VFS doesn't match this mount's VFS,
                or a tree declares an installation's own setting.
        """
        commands, trees = self._accepted(fns)
        for rc in commands:
            self.register(rc)
        for root, cli in trees:
            self._trees[root.name] = (root, cli)

    def _accepted(
        self, fns: Iterable[Any]
    ) -> tuple[list[Command], list[tuple[Command, CLI]]]:
        """The registrations among ``fns`` that belong to this mount's VFS.

        Grouped by name, because a family table fans out over sibling VFS
        names, so most entries a mount is handed may belong to a sibling
        and are simply skipped. A name whose entries name only other VFS
        is the real mistake (a table built for the wrong backend), and
        that still raises.

        Args:
            fns (iterable): Decorated functions or Command values.

        Raises:
            ValueError: If a command's VFS doesn't match this mount's VFS.
        """
        pname = self.vfs.name
        cmd_groups: dict[str, tuple[list[Command], set[str]]] = {}
        trees: list[tuple[Command, CLI]] = []
        for fn in fns:
            rcs: list[Command]
            if isinstance(fn, CLI):
                root = _tree_command(fn)
                trees.append((root, fn))
                rcs = [root]
            elif isinstance(fn, Command):
                rcs = [fn]
            else:
                rcs = getattr(fn, "_registered_commands", [])
            for rc in rcs:
                keep, attempted = cmd_groups.setdefault(rc.name, ([], set()))
                if rc.vfs is None or rc.vfs == pname:
                    keep.append(rc)
                else:
                    attempted.add(rc.vfs)
        for name, (keep, attempted) in cmd_groups.items():
            if not keep:
                raise ValueError(
                    f"command {name!r} is for VFS(s) "
                    f"{sorted(attempted)!r}, not {pname!r}"
                )
        commands = [
            rc for keep, _attempted in cmd_groups.values() for rc in keep
        ]
        return commands, trees

    def cli_for(self, cmd_name: str) -> CLI | None:
        """The command tree this mount serves under ``cmd_name``, None
        when the name resolves to any other command here.

        Args:
            cmd_name (str): command name.
        """
        tree = self._trees.get(cmd_name)
        if tree is None or self.resolve_command(cmd_name) is not tree[0]:
            return None
        return tree[1]

    def commands(self) -> dict[str, list[str | None]]:
        """List registered commands grouped by filetype variants.

        Returns:
            dict[str, list[str | None]]: Command name to filetype list.
        """
        result: dict[str, list[str | None]] = {}
        for name, filetype in self._cmds:
            result.setdefault(name, []).append(filetype)
        for name in self._general_cmds:
            result.setdefault(name, [])
        for name in result:
            result[name] = sorted(
                result[name], key=lambda x: (x is not None, x or "")
            )
        return dict(sorted(result.items()))

    def require_writable(
        self, name: str, path: PathSpec, values: Iterable[Any]
    ) -> None:
        """Refuse a write the mount's mode no longer grants at any path.

        Admission judged the mode before the call waited for the mount
        and for its write lock; ``set_mount_mode`` can make the mount
        read-only in between, so the mode is read again here, as the
        backend call starts. A call that reaches a subtree (a rename, a
        tree removal or copy) is refused by a read-only region anywhere
        below its paths, and a copy only reads its source.

        Args:
            name (str): the function name.
            path (PathSpec): the path the call names.
            values (Iterable[Any]): the call's other arguments; each
                PathSpec among them is a path it reaches.
        """
        mark = declared(type(self.vfs), name)
        if mark is None or mark.effect not in WRITE_EFFECTS:
            return
        others = [v for v in values if isinstance(v, PathSpec)]
        require_paths_writable(
            others if mark.effect is Effect.COPY else [path, *others],
            self.prefix,
            self.mode,
            subtree=mark.subtree,
        )

    def refuse_keywords(self, name: str, kwargs: dict[str, Any]) -> None:
        """Refuse a keyword ``name`` does not take, as a cold call would.

        Args:
            name (str): the function name.
            kwargs (dict[str, Any]): the call's keywords; ``filetype`` is
                the mount's own and passes.
        """
        taken = {k: v for k, v in kwargs.items() if k != "filetype"}
        for fn in self._callers(name, None):
            _taken(name, fn, taken)

    def renders(self, filetype: str | None) -> bool:
        """Whether the VFS renders a read of ``filetype``.

        A rendered read is never served from or kept in the file cache.

        Args:
            filetype (str | None): the extension.
        """
        return filetype is not None and filetype in self.vfs.renderers

    def _resolve_cascade(
        self,
        name: str,
        extension: str | None,
        table: dict[tuple[Any, ...], Any],
        general: dict[str, Any] | None = None,
    ) -> list[Any]:
        """Resolve with cascade: try filetype, VFS, general.

        Returns list of matching entries to try in order.
        First non-None result wins.
        """
        levels = []
        if extension:
            entry = table.get((name, extension))
            if entry is not None:
                levels.append(entry)
        entry = table.get((name, None))
        if entry is not None:
            levels.append(entry)
        entry = general.get(name) if general is not None else None
        if entry is not None:
            levels.append(entry)
        return levels

    def reads_ranges(self, path: str) -> bool:
        """Whether a ranged read of `path` fetches only that range.

        False where the read that answers it reads the whole file and
        slices: a VFS with no native range, or a rendered filetype.

        Args:
            path (str): virtual path.
        """
        return self.vfs.reads_ranges and not self.renders(get_extension(path))

    # ── execution ─────────────────────────────────────

    async def run_command(
        self,
        cmd_name: str,
        paths: list[PathSpec],
        texts: list[str],
        flag_kwargs: dict[str, FlagValue],
        ctx: Context = Context(),
        limit_override: Limit | None = None,
    ) -> tuple[ByteSource | None, IOResult]:
        """Execute a command on this mount's VFS.

        Pure dispatch — flag parsing is done upstream in
        executor/command.py. This method picks the handler, builds its
        options, runs it in this mount's scope and wraps what it returns.

        Args:
            cmd_name (str): command name.
            paths (list[PathSpec]): positional path args.
            texts (list[str]): positional text args.
            flag_kwargs (dict): parsed flags from upstream.
            ctx (Context): what the workspace supplies beyond the
                parsed line (the fifth argument TypeScript's
                ``runCommand`` has always taken); the handler gets it
                with the facts only this mount can supply added. A
                handler reads the fields it wants, so no list of command
                names is kept here.
            limit_override (Limit | None): the caller's output limit,
                which the mount applies itself.
        """
        async with self.use():
            handlers = await self._pick_handlers(
                cmd_name, paths, vfs_stat_path(ctx.vfs)
            )
            if not handlers:
                return None, IOResult(
                    exit_code=127,
                    stderr=encode_text(f"{cmd_name}: command not found"),
                )
            with self._command_scope(ctx):
                for cmd in handlers:
                    user = self._is_user_command(cmd)
                    operands = (
                        self._keyed_paths(cmd_name, paths)
                        if user
                        else [virtual_key(p) for p in paths]
                    )
                    flags = (
                        self._keyed_flags(flag_kwargs)
                        if user
                        else virtual_flags(flag_kwargs)
                    )
                    refusal = self._command_refusal(cmd_name, cmd, flags)
                    if refusal is not None:
                        return None, refusal
                    result = await self._run_one(
                        cmd_name,
                        cmd,
                        operands,
                        texts,
                        self._command_ctx(
                            flags, ctx, self.prefix if user else ""
                        ),
                        limit_override,
                        paths,
                    )
                    if result is not None:
                        return result
                return None, IOResult()

    def write_context(self) -> WriteContext | None:
        """What a write through this mount must carry, None when its writes
        are unconditional.

        Pushed by both entry points whatever the policy, so an unconditional
        mount clears a context an outer command's mount set.
        """
        manager = self.cache_manager
        if self.write is not WritePolicy.CONDITIONAL or manager is None:
            return None
        return WriteContext(
            vfs=self.vfs.name,
            conditions=write_conditions(self.vfs),
            read_version=manager.read_version,
            read_versions=manager.read_versions,
            drop=lambda path: manager.invalidate(path, FileChangeKind.UPDATE),
            keep=manager.keep_version,
        )

    async def _pick_handlers(
        self,
        cmd_name: str,
        paths: list[PathSpec],
        stat_path: StatPath | None,
    ) -> list[Command]:
        """The handlers to try in order.

        A filetype handler is selected from the operand's NAME, and a
        directory can carry any extension, so the cascade would hand a
        renderer a directory to read. One stat settles it, and only when
        a handler for this exact extension exists, so a mount with no
        filetype registrations never reaches the probe. The built-in is
        what a directory should get: it owns GNU's `Is a directory`
        wording, and the renderer owns nothing but its own format. The
        DISPATCHER's stat, not the backend's, so a mount root and a
        namespace-only directory answer too; None means neither plane
        saw anything, in which case the renderer reports its own miss.

        Args:
            cmd_name (str): command name.
            paths (list[PathSpec]): positional path args.
            stat_path (StatPath | None): the dispatcher's stat.
        """
        extension = get_extension(paths[0].virtual) if paths else None
        if (
            extension is not None
            and paths
            and stat_path is not None
            and (cmd_name, extension) in self._cmds
        ):
            entry = await stat_path(paths[0].virtual)
            if entry is not None and entry.type == FileType.DIRECTORY:
                extension = None
        return self._resolve_cascade(
            cmd_name, extension, self._cmds, self._general_cmds
        )

    def _keyed_paths(
        self, cmd_name: str, paths: list[PathSpec]
    ) -> list[PathSpec]:
        """Stamp this mount's backend key onto each path operand, for a
        handler that addresses its backend through the mount's accessor
        (a user command, a command tree's leaf); mirage's own commands
        get every path keyed by its whole virtual path (``virtual_key``)
        and reach it through their files.

        A stdin `-` routed nowhere, so it rides on whichever mount runs
        the line, beside the operands that chose it.

        Args:
            cmd_name (str): command name.
            paths (list[PathSpec]): positional path args.
        """
        mount_prefix = self.prefix.rstrip("/")
        stdin_slots = (
            STDIN_DASH_LEADING.get(cmd_name, len(paths))
            if cmd_name in STDIN_DASH_COMMANDS
            else 0
        )
        return [
            dataclasses.replace(p, virtual=f"{mount_prefix}/-", vfs_path="-")
            if isinstance(p, PathSpec)
            and index < stdin_slots
            and p.raw_path == "-"
            else dataclasses.replace(
                p, vfs_path=mount_key(p.virtual, mount_prefix)
            )
            if isinstance(p, PathSpec)
            else p
            for index, p in enumerate(paths)
        ]

    def _keyed_flags(
        self, flag_kwargs: dict[str, FlagValue]
    ) -> dict[str, FlagValue]:
        """Stamp this mount's backend key onto path-shaped flag values.

        Backend reads can then address them: a single PathSpec (e.g. awk
        -f, single grep -f) or a list of PathSpec (multiple grep -f).
        Everything else (bools, strings, list[str] like repeated -e) is
        not a path and passes through unchanged.

        Args:
            flag_kwargs (dict[str, FlagValue]): parsed flags from upstream.
        """
        mount_prefix = self.prefix.rstrip("/")
        flags: dict[str, FlagValue] = FlagBag(flag_kwargs)
        for k, v in flag_kwargs.items():
            if isinstance(v, PathSpec):
                flags[k] = dataclasses.replace(
                    v, vfs_path=mount_key(v.virtual, mount_prefix)
                )
            elif (
                isinstance(v, list)
                and v
                and all(isinstance(item, PathSpec) for item in v)
            ):
                specs = [item for item in v if isinstance(item, PathSpec)]
                flags[k] = [
                    dataclasses.replace(
                        item, vfs_path=mount_key(item.virtual, mount_prefix)
                    )
                    for item in specs
                ]
            else:
                flags[k] = v
        return flags

    def _command_ctx(
        self, flags: dict[str, FlagValue], ctx: Context, prefix: str
    ) -> Context:
        """The context a handler reads: the workspace's, its flags and its
        working directory keyed below ``prefix`` (mirrors
        Mount.runCommand).

        Args:
            flags (dict[str, FlagValue]): the handler's flags.
            ctx (Context): the workspace's context for the command.
            prefix (str): this mount's prefix for a handler
                ``_keyed_paths`` keys the operands of; empty for mirage's
                own commands, whose paths keep their whole virtual path.
        """
        cwd = ctx.cwd.virtual
        return dataclasses.replace(
            ctx,
            flags=flags,
            cwd=PathSpec(
                virtual=cwd,
                directory=cwd,
                resolved=False,
                vfs_path=mount_key(cwd, prefix.rstrip("/")),
            ),
        )

    @contextmanager
    def _command_scope(self, ctx: Context) -> Iterator[None]:
        """Bind what a handler's calls read from the context.

        The recorder's mount, the snapshot revision pins, the mount's
        cache manager and write context; the mount the command runs on
        (``mount``), which tells its files' calls a run on one mount from
        one across mounts and names the mount whose facts they ask; and
        the dispatcher's stat and link follow, which a builder proves an
        operand's `.` and `..` with before it makes what the walk names
        (``mkdir -p``).

        Args:
            ctx (Context): the handler's context.
        """
        outer = current_caller()
        links = link_view(ctx.vfs)
        dispatch = dispatch_of(ctx)
        token = bind_caller(
            dataclasses.replace(
                self._on_mount(outer),
                cache_manager=self.cache_manager,
                mount=(self.prefix, self.mode),
                walk_probe=(
                    WalkProbe(
                        stat=functools.partial(dispatch_stat, dispatch),
                        follow=link_follow(links),
                    )
                    if dispatch is not None
                    else outer.walk_probe
                ),
            )
        )
        try:
            yield
        finally:
            reset_caller(token)

    def _command_refusal(
        self,
        cmd_name: str,
        cmd: Command,
        flags: dict[str, FlagValue],
        served: Command | None = None,
    ) -> IOResult | None:
        """Refuse user handlers on hidden mounts or read-only writes.

        Mirage's own commands are refused where they write, by the
        dispatcher, because only the write knows whether a line writes:
        `gzip -c`, `tar -t` and `split -n 1/2` read a read-only mount like
        any reader, and `gzip f` is refused at the write of `f.gz`, in
        gzip's own GNU voice. A user write command reaches its service
        through its own handle (``_is_user_command``), so it is refused
        here, before it runs, because no gate would see its write.
        strongest_mode_under, not effective_mode: a mount whose only
        writable region is a show entry still runs it. Only wrapper-owned
        responses (an injected help or version) bypass it: a handler
        that declares ``--help`` itself is handed the flag and runs. The
        trailing newline is load-bearing: stderr accumulates across a
        line.

        Args:
            cmd_name (str): command name.
            cmd (Command): the handler about to run.
            flags (dict[str, FlagValue]): the keyed flags.
            served (Command | None): the command this mount serves it
                under, which says whether it is a user command: a tree's
                root for one of its leaves; None for ``cmd`` itself.
        """
        user = self._is_user_command(served or cmd)
        if user and not path_visible(session_visibility(), self.prefix):
            return IOResult(
                exit_code=127,
                stderr=encode_text(f"{cmd_name}: command not found\n"),
            )
        info_only = (
            flags.get("help") is True and has_injected_help(cmd.spec)
        ) or (flags.get("version") is True and has_injected_version(cmd.spec))
        if (
            cmd.write
            and user
            and not info_only
            and strongest_mode_under(self.prefix, self.mode) == MountMode.READ
        ):
            return IOResult(
                exit_code=1,
                stderr=encode_text(
                    f"{cmd_name}: read-only mount at {self.prefix}\n"
                ),
            )
        return None

    async def _run_one(
        self,
        cmd_name: str,
        cmd: Command,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        limit_override: Limit | None,
        typed: list[PathSpec],
    ) -> CommandFnResult:
        """Run one handler under the mount-resolved timeout, through the
        runner a CLI leaf shares, in this mount's voice.

        The dispatch-level guard only sees default limits (the mount is
        unknown before routing), so the mount-resolved timeout must also
        bound the command body: eager commands do their work inside
        cmd.fn, where the stream-consumption guard never runs. A user
        command that declares a write reaches its backend through its
        own handle, past the dispatcher's per-path invalidation, so this
        mount drops its caches once it has run; mirage's own commands
        write through the dispatcher and drop nothing.

        Args:
            cmd_name (str): command name.
            cmd (Command): the handler to run.
            paths (list[PathSpec]): the keyed path operands.
            texts (list[str]): positional text args.
            ctx (Context): the handler's context.
            limit_override (Limit | None): the caller's output limit.
            typed (list[PathSpec]): the operands as the line typed them,
                which a file error names.
        """
        limit = resolve_limit(
            cmd_name,
            command_default=cmd.limit,
            mount_override=limit_override or self.command_limits.get(cmd_name),
        )
        ctx = dataclasses.replace(ctx, spec=_named_spec(cmd, cmd_name))
        with host_io():
            return await run_handler(
                cmd.fn(self.vfs.accessor, paths, texts, ctx),
                cmd_name,
                limit,
                Producer(
                    command=cmd_name,
                    prefixes=(self.prefix,),
                    declared=cmd.limit,
                ),
                mount_voice(cmd_name, typed),
                drop=(
                    self.drop_caches
                    if cmd.write and self._is_user_command(cmd)
                    else None
                ),
                scope=lambda result: _wrap_mount_streams(
                    result, self.activity
                ),
                vfs=ctx.vfs,
            )

    async def run_leaf(
        self,
        prog: str,
        cli: CLI,
        handler: CLIHandler,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        limit: Limit | None,
    ) -> CommandFnResult:
        """Run one leaf of a command tree this mount serves.

        The executor walked the line and parsed the leaf's words, as it
        does an installed CLI's; the leaf runs here as a command does: on
        this mount's accessor, in its scope, under the read-only refusal
        for its own ``write`` and, being a user command that holds the
        raw handle, the refusal a restricting session gets. Its failures
        speak in a CLI's voice.

        Args:
            prog (str): the head and the verb path.
            cli (CLI): the tree.
            handler (CLIHandler): the leaf's execution and policy.
            paths (list[PathSpec]): the leaf's path operands.
            texts (list[str]): the leaf's text operands.
            ctx (Context): the leaf's context.
            limit (Limit | None): the resolved limit.
        """
        root = self.resolve_command(cli.spec.name)
        fn = handler.fn
        if fn is None or root is None:
            raise RuntimeError(f"{prog}: no command tree serves it here")
        leaf = Command(
            name=prog,
            spec=ctx.spec if ctx.spec is not None else cli.spec,
            vfs=None,
            filetype=None,
            fn=fn,
            write=handler.write,
            limit=handler.limit,
        )
        async with self.use():
            keyed = self._keyed_paths(prog, paths)
            flags = self._keyed_flags(FlagBag(ctx.flags))
            run_ctx = self._command_ctx(flags, ctx, self.prefix)
            with self._command_scope(run_ctx):
                # No flag here is answered for the leaf: walk_leaf answered
                # the tree's own help, and the leaf is handed the rest.
                refusal = self._command_refusal(prog, leaf, {}, root)
                if refusal is not None:
                    return None, refusal
                with host_io():
                    return await run_handler(
                        answered(
                            call_leaf(
                                fn, self.vfs.accessor, keyed, texts, run_ctx
                            )
                        ),
                        prog,
                        limit,
                        Producer(
                            command=prog,
                            prefixes=(self.prefix,),
                            declared=handler.limit,
                        ),
                        cli_voice(prog),
                        drop=(
                            self.drop_caches
                            if handler.write and self._is_user_command(root)
                            else None
                        ),
                        scope=lambda result: _wrap_mount_streams(
                            result, self.activity
                        ),
                        vfs=run_ctx.vfs,
                    )

    async def drop_caches(self, bodies: bool = True) -> None:
        """Drop what this mount keeps after a write that went past the
        dispatcher: its listings and bodies (``CacheManager.drop``), and
        the answers its client keeps of its own (``Accessor.forget``).

        Args:
            bodies (bool): drop the bodies too; False when the registry
                clears the whole file cache itself.
        """
        if self.cache_manager is not None:
            await self.cache_manager.drop(bodies)
        else:
            await self.index_store.invalidate()
        self.accessor.forget()

    @property
    def accessor(self) -> Accessor:
        """The client this mount's VFS reaches its backend with."""
        return self.vfs.accessor

    def answers_at(self, name: str, path: str) -> bool:
        """Report whether an op would resolve for a path on this mount.

        Args:
            name (str): operation name (e.g. "setattr").
            path (str): virtual path (drives filetype-specific lookup).
        """
        return bool(self._callers(name, get_extension(path)))

    def _callers(
        self, name: str, filetype: str | None
    ) -> list[Callable[..., Any]]:
        """What answers ``op_name`` on this mount, in the order to try.

        A rendered filetype's renderer answers a read before ``read``
        does, window and all, and the first answer that is not None wins.
        The rest is the dispatcher's own shape around the VFS's functions: a
        read takes a window, ``append`` and ``pwrite`` are a rewrite where
        the VFS only writes whole files, and ``mkdir`` refuses a taken
        name first. Only a function marked ``@vfs_call`` is reachable by
        name.

        Args:
            name (str): the op name.
            filetype (str | None): the extension the read resolves by.
        """
        vfs = self.vfs
        if name == "read":
            levels: list[Callable[..., Any]] = []
            renderer = (
                vfs.renderers.get(filetype) if filetype is not None else None
            )
            if renderer is not None:
                levels.append(
                    functools.partial(
                        _read_window, getattr(vfs, renderer), True
                    )
                )
            if vfs.supports("read"):
                levels.append(
                    functools.partial(_read_window, vfs.read, vfs.reads_ranges)
                )
            return levels
        if name == "write" and vfs.supports("write"):
            return [self._write_op]
        if name == "append" and (
            vfs.supports("append") or vfs.supports("write")
        ):
            return [self._append_op]
        if name in ("pwrite", "truncate") and not vfs.supports(name):
            return (
                [getattr(self, f"_{name}_by_rewrite")]
                if vfs.supports("write")
                else []
            )
        if name == "pwrite":
            return [self._pwrite]
        if name == "mkdir" and vfs.supports("mkdir"):
            return [self._mkdir]
        if declared(type(vfs), name) is None or not vfs.supports(name):
            return []
        return [getattr(vfs, name)]

    async def _write_op(
        self,
        path: PathSpec,
        data: ByteSource,
        atomic: bool = False,
        index: IndexCacheStore = NULL_INDEX,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> Any:
        """A write of bytes or a stream, handed to the VFS's ``write`` as
        it came. An atomic write to a ``write`` that takes no ``atomic``
        is collected first, so it lands whole.

        Args:
            path (PathSpec): the file, keyed below the mount.
            data (ByteSource): its whole content, consumed once.
            atomic (bool): stage a streamed replacement until it ends.
            index (IndexCacheStore): the mount's index.
            entry (FileStat | None): what is at the path, if handed.
            parent (FileStat | None): its directory, if handed.
        """
        try:
            write: Callable[..., Awaitable[Any]] = self.vfs.write
            staged: dict[str, bool] = {}
            if atomic:
                names = _parameters(getattr(write, "__func__", write))
                if names is None or "atomic" in names:
                    staged["atomic"] = True
                else:
                    data = await materialize(data)
            return await write(
                path,
                data,
                **staged,
                **_handed_on(write, index, entry=entry, parent=parent),
            )
        finally:
            await close_quietly(data)

    async def _append_op(
        self,
        path: PathSpec,
        data: ByteSource,
        index: IndexCacheStore = NULL_INDEX,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> Any:
        """An append of bytes or a stream, handed to the VFS's ``append``
        as it came, or by rewrite where the VFS has no append.

        Args:
            path (PathSpec): the file, keyed below the mount.
            data (ByteSource): the bytes to add, consumed once.
            index (IndexCacheStore): the mount's index.
            entry (FileStat | None): what is at the path, if handed.
            parent (FileStat | None): its directory, if handed.
        """
        try:
            if not self.vfs.supports("append"):
                return await self._append_by_rewrite(
                    path, await materialize(data), index
                )
            append: Callable[..., Awaitable[Any]] = self.vfs.append
            return await append(
                path,
                data,
                **_handed_on(append, index, entry=entry, parent=parent),
            )
        finally:
            await close_quietly(data)

    async def _append_by_rewrite(
        self,
        path: PathSpec,
        data: bytes,
        index: IndexCacheStore = NULL_INDEX,
    ) -> FileStat | None:
        return await append_by_rewrite(
            functools.partial(self._read, index),
            functools.partial(self._write, index),
            functools.partial(self._stat, index),
            path,
            data,
        )

    async def _pwrite_by_rewrite(
        self,
        path: PathSpec,
        data: bytes,
        offset: int,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await pwrite_by_rewrite(
            functools.partial(self._read, index),
            functools.partial(self._write, index),
            functools.partial(self._stat, index),
            path,
            data,
            expect_offset(offset, path),
        )

    async def _truncate_by_rewrite(
        self,
        path: PathSpec,
        length: int,
        no_create: bool = False,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await truncate_by_rewrite(
            functools.partial(self._read, index),
            functools.partial(self._write, index),
            path,
            length,
            no_create,
        )

    async def _read(self, index: IndexCacheStore, path: PathSpec) -> bytes:
        """The VFS's read of a whole file, handed what is at its path.

        Args:
            index (IndexCacheStore): the mount's index.
            path (PathSpec): the file, keyed below the mount.
        """
        return await _collected(
            await self._answer(index, path), path, True, index.clock
        )

    async def _answer(
        self, index: IndexCacheStore, path: PathSpec
    ) -> Awaitable[ByteSource] | AsyncIterator[bytes]:
        """What the VFS's read of a whole file returns, called with the
        stats it declares.

        Args:
            index (IndexCacheStore): the mount's index.
            path (PathSpec): the file, keyed below the mount.
        """
        read = self.vfs.read
        handed = await self._handed(read, path, {}, index)
        return read(path, **_handed_on(read, index, **handed))

    async def _write(
        self, index: IndexCacheStore, path: PathSpec, data: bytes
    ) -> Any:
        """The VFS's write of a whole file, handed what is at its path
        and the directory it goes in.

        Args:
            index (IndexCacheStore): the mount's index.
            path (PathSpec): the file, keyed below the mount.
            data (bytes): its whole content.
        """
        write: Callable[..., Awaitable[Any]] = self.vfs.write
        handed = await self._handed(write, path, {}, index)
        return await write(
            path, data, **_handed_on(write, NULL_INDEX, **handed)
        )

    async def _pwrite(
        self,
        path: PathSpec,
        data: bytes,
        offset: int,
        index: IndexCacheStore = NULL_INDEX,
        entry: FileStat | None = None,
    ) -> Any:
        return await self.vfs.pwrite(
            path,
            data,
            expect_offset(offset, path),
            **_handed_on(self.vfs.pwrite, index, entry=entry),
        )

    async def _mkdir(
        self,
        path: PathSpec,
        parents: bool = False,
        index: IndexCacheStore = NULL_INDEX,
        parent: FileStat | None = None,
    ) -> Any:
        await refuse_taken(functools.partial(self._stat, index), path, parents)
        mkdir: Callable[..., Awaitable[Any]] = self.vfs.mkdir
        if parents and "parent" in _wants(mkdir):
            return await self._mkdir_levels(path, index)
        made = await mkdir(
            path,
            parents=parents,
            **({} if parent is None else {"parent": parent}),
        )
        if not parents and isinstance(made, FileStat):
            # A directory made new holds nothing yet.
            await index.set_dir(index_key(self.prefix, path), [])
        return made

    async def _mkdir_levels(
        self, path: PathSpec, index: IndexCacheStore
    ) -> Any:
        """``mkdir -p`` on a backend that makes a directory inside its
        parent's entry: one level at a time, from the mount root down.

        The level above does not exist yet when the one below needs it
        as its parent, so each level's create answers its new stat and
        the index keeps it where the next level looks for its parent,
        with its own listing, which is empty.
        A level that is there already is passed, a directory or not:
        a file there is ENOTDIR for the level below, as mkdir(2) finds.

        Args:
            path (PathSpec): the deepest directory to make.
            index (IndexCacheStore): the mount's index.
        """
        names = [n for n in path.vfs_path.strip("/").split("/") if n]
        root = self.prefix.rstrip("/")
        mkdir: Callable[..., Awaitable[Any]] = self.vfs.mkdir
        made: Any = None
        for depth in range(1, len(names) + 1):
            level = self._scope(f"{root}/{'/'.join(names[:depth])}")
            key = index_key(self.prefix, level)
            found = await self._entry(level, index)
            if found is not None:
                if found.type is not FileType.DIRECTORY:
                    raise enotdir(level)
                continue
            parent = await self._entry(self._folder(level), index)
            made = await mkdir(
                level, **({} if parent is None else {"parent": parent})
            )
            if isinstance(made, FileStat):
                await index.add_entry(key, made)
                await index.set_dir(key, [])
        return made

    @property
    def _root_key(self) -> str:
        """The index key of this mount's root, which no listing names."""
        return self.prefix.rstrip("/") or "/"

    def _folder(self, scope: PathSpec) -> PathSpec:
        """The directory holding ``scope``, keyed below this mount; a glob
        word stands for the directory it lists, and the root holds itself.

        Args:
            scope (PathSpec): a path below the mount root.
        """
        target = scope.dir if scope.pattern else scope
        if index_key(self.prefix, target) == self._root_key:
            return target
        return self._scope(target.virtual.rstrip("/").rsplit("/", 1)[0] or "/")

    @property
    def _lists(self) -> bool:
        """Whether the VFS lists, so the mount keeps its listings as
        stats."""
        return self.vfs.supports("readdir")

    async def _stored_row(
        self, index: IndexCacheStore, key: str
    ) -> FileStat | None:
        """The row the stored listings answer a stat of ``key`` with, None
        for one the backend must answer, a miss they do not prove
        (``_unproven``) included.

        Args:
            index (IndexCacheStore): the mount's index.
            key (str): the path's key, below the mount root.
        """
        return self._whole(
            await stored_stat(
                index, key, functools.partial(self._proves, index)
            )
        )

    def _proves(self, index: IndexCacheStore, folder: str) -> bool:
        """Whether a complete listing of ``folder`` proves a name it
        leaves out absent: always, but on a VFS that checks such a name
        again (``_unproven``), only a listing the running command fetched.

        Args:
            index (IndexCacheStore): the mount's index.
            folder (str): the folder's key.
        """
        checks = self._asks_by_path or self.vfs.supports("write")
        return not checks or index.listed_this_command(folder)

    @property
    def _asks_by_path(self) -> bool:
        """Whether the VFS's stat asks by path, handed no stored row."""
        return self._lists and not _wants(self.vfs.stat)

    async def _unproven(self, index: IndexCacheStore, key: str) -> bool:
        """Whether the stored listings leave ``key`` out without proving
        it absent (``unproven_miss``), on a VFS that checks such a name
        again: one whose stat asks by path (one stat) or one that writes
        (its folder is listed again), where a stale miss would let a
        write land over a file another client made.

        Args:
            index (IndexCacheStore): the mount's index.
            key (str): the path's key, below the mount root.
        """
        return (
            self._asks_by_path or self.vfs.supports("write")
        ) and await unproven_miss(index, key)

    def _backend_fn(self, fn: Callable[..., Any]) -> Callable[..., Any]:
        """The VFS function a mount wrapper calls, whose parameters say
        which stats it is handed.

        Args:
            fn (Callable[..., Any]): what ``_callers`` answered.
        """
        if isinstance(fn, functools.partial) and fn.func is _read_window:
            return cast(Callable[..., Any], fn.args[0])
        if fn == self._mkdir:
            return self.vfs.mkdir
        if fn == self._pwrite:
            return self.vfs.pwrite
        if fn == self._write_op:
            return self.vfs.write
        if fn == self._append_op:
            return (
                self.vfs.append
                if self.vfs.supports("append")
                else self._append_by_rewrite
            )
        return fn

    async def _entry(
        self, scope: PathSpec, index: IndexCacheStore
    ) -> FileStat | None:
        """What is at ``scope``, as its parent's listing names it, listing
        the parent when no stored listing does. Under ``fresh`` the running
        command's check of ``scope`` already asked the backend, so its
        answer stands in for the walk; a check itself always walks. A miss
        right after a listing of the parent landed, with no listing left
        now, says only that a check cleared the index mid-lookup, so it is
        looked up once more.

        Args:
            scope (PathSpec): a path keyed below the mount.
            index (IndexCacheStore): the mount's index.
        """
        key = index_key(self.prefix, scope)
        if key == self._root_key or not self._lists:
            return None
        manager = self.cache_manager
        if manager is not None and not isinstance(index, ListingCheckStore):
            probed = manager.probed_stat(scope)
            if probed is not None:
                return probed
        listed: list[str] = []

        async def warm() -> list[str]:
            names = await self._listed(self._folder(scope), index)
            listed.append(key)
            return names

        row = await entry_at(index, key, warm)
        if (
            row is None
            and listed
            and index is not NULL_INDEX
            and (await index.list_dir(folder_of(key), key)).status
            is LookupStatus.NOT_FOUND
        ):
            row = await entry_at(index, key, warm)
        if row is not None:
            return row
        if await beyond_window(index, key):
            return await self._beyond(scope, index)
        if not await self._unproven(index, key):
            return None
        if self._asks_by_path:
            return await self._beyond(scope, index)
        await index.invalidate_dir(folder_of(key))
        return await entry_at(index, key, warm)

    async def _beyond(
        self, scope: PathSpec, index: IndexCacheStore
    ) -> FileStat | None:
        """What is at a path its folder's stored listing leaves out
        without proving it absent (a window, or a listing another
        command fetched): the backend's stat of it, handed what is at
        its parent; None when nothing is.

        Args:
            scope (PathSpec): a path keyed below the mount.
            index (IndexCacheStore): the mount's index.
        """
        stat: Callable[..., Awaitable[FileStat]] = self.vfs.stat
        handed: dict[str, FileStat | None] = {}
        if "parent" in _wants(stat):
            handed["parent"] = await self._entry(self._folder(scope), index)
        try:
            return await stat(scope, **_handed_on(stat, index, **handed))
        except FileNotFoundError as exc:
            logger.debug("nothing unlisted at %s: %s", scope, exc)
            return None

    async def _listed(
        self, path: PathSpec, index: IndexCacheStore
    ) -> list[str]:
        """A directory's children, from its stored listing or listed
        through the backend and kept. Finding the rows a listing is
        handed lists its parent, whose fetch may have proved this listing
        too (a seed).

        Args:
            path (PathSpec): the directory, keyed below the mount.
            index (IndexCacheStore): the mount's index.
        """
        key = index_key(self.prefix, path)
        glob = path.pattern is not None
        stored = await stored_listing(index, key, glob=glob)
        if stored is not None:
            return stored
        readdir: Callable[..., Awaitable[Any]] = self.vfs.readdir
        handed = await self._handed(readdir, path, {}, index)
        stored = await stored_listing(index, key, glob=glob)
        if stored is not None:
            return stored
        listed = await readdir(path, **_handed_on(readdir, index, **handed))
        return await keep_listing(index, key, listed)

    async def _level(
        self, virtual: str, limit: int | None
    ) -> dict[str, FileStat] | None:
        """One level of a subtree read: the directory's listing, as
        ``readdir`` answers it, each child keyed by its name with the row
        its ``stat`` answers from that listing. None where a stat does
        not come from the listing: a mount that keeps none, or whose
        index keeps no listing live (a zero ttl), one under ``read:
        fresh``, whose stats check the backend, a listing the index does
        not hold live once listed, and a child whose row a stat would
        finish (``_whole``). A listing cut at the walk's limit answers
        for the children it names, as their stats do.

        Args:
            virtual (str): the directory.
            limit (int | None): the listing's limit, as a walk hands it.
        """
        index = self.index
        if (
            not self._lists
            or self.read.policy is ReadPolicy.FRESH
            or index.ttl <= 0
        ):
            return None
        names = await self.call(
            "readdir", virtual, **({} if limit is None else {"limit": limit})
        )
        listing = await index.list_dir(
            index_key(self.prefix, self._scope(virtual))
        )
        held = (
            listing.entries
            if listing.entries is not None
            else listing.partial_entries
        )
        if held is None:
            return None
        live = set(held)
        rows = await index.get_many(names)
        found: dict[str, FileStat] = {}
        for child in names:
            row = self._whole(rows.get(child)) if child in live else None
            if row is None:
                return None
            found[child.rsplit("/", 1)[-1]] = row
        return found

    async def _stat(self, index: IndexCacheStore, path: PathSpec) -> FileStat:
        """A stat of ``path`` on this mount, as ``call`` answers one.

        Args:
            index (IndexCacheStore): the mount's index.
            path (PathSpec): the path, keyed below the mount.
        """
        stat: Callable[..., Awaitable[FileStat]] = self.vfs.stat
        if not self._lists:
            return await stat(path, **_handed_on(stat, index))
        stored = await self._stored("stat", path, index)
        if stored is not None:
            return stored
        handed = await self._handed(stat, path, {}, index)
        return await stat(path, **_handed_on(stat, index, **handed))

    async def _handed(
        self,
        fn: Callable[..., Any],
        scope: PathSpec,
        kwargs: dict[str, Any],
        index: IndexCacheStore,
    ) -> dict[str, FileStat | None]:
        """The stats ``fn`` declares, each found in the stored listings.

        Args:
            fn (Callable[..., Any]): the function about to run.
            scope (PathSpec): its path, keyed below the mount.
            kwargs (dict[str, Any]): its keywords; a rename's or a copy's
                ``dst`` is the destination.
            index (IndexCacheStore): the mount's index.
        """
        backend = self._backend_fn(fn)
        if isinstance(index, ListingCheckStore) and _takes_index(backend):
            # Under a fresh check a function that takes the check's store
            # answers from its hints: walking for its stats would cost the
            # requests it saves.
            return {}
        wants = _wants(backend)
        handed: dict[str, FileStat | None] = {}
        if "entry" in wants:
            handed["entry"] = await self._entry(scope, index)
        if "parent" in wants:
            handed["parent"] = await self._entry(self._folder(scope), index)
        dst = kwargs.get("dst")
        if isinstance(dst, PathSpec) and wants & {"dst_entry", "dst_parent"}:
            there = self._scope(dst.virtual)
            if "dst_entry" in wants:
                handed["dst_entry"] = await self._entry(there, index)
            if "dst_parent" in wants:
                handed["dst_parent"] = await self._entry(
                    self._folder(there), index
                )
        return handed

    @overload
    async def _stored(
        self, name: Literal["stat"], scope: PathSpec, index: IndexCacheStore
    ) -> FileStat | None: ...

    @overload
    async def _stored(
        self, name: str, scope: PathSpec, index: IndexCacheStore
    ) -> FileStat | list[str] | dict[str, FileStat] | None: ...

    async def _stored(
        self, name: str, scope: PathSpec, index: IndexCacheStore
    ) -> FileStat | list[str] | dict[str, FileStat] | None:
        """A listing or a stat the stored listings answer, None for one
        the backend must.

        Args:
            name (str): ``readdir`` or ``stat``.
            scope (PathSpec): the path, keyed below the mount.
            index (IndexCacheStore): the mount's index.
        """
        key = index_key(self.prefix, scope)
        if name == "readdir":
            return await stored_listing(
                index, key, glob=scope.pattern is not None
            )
        if name == "read_tree":
            return None if self._names_only else await stored_tree(index, key)
        if key == self._root_key:
            return None
        row = await self._stored_row(index, key)
        if row is None or not self._names_only:
            return row
        manager = self.cache_manager
        trusted = manager is not None and manager.listing_trusted(
            folder_of(key)
        )
        return row if trusted else None

    def _whole(self, row: FileStat | None) -> FileStat | None:
        """A stored row that answers a stat whole, None for one the
        backend must finish: a file with no size, on a VFS whose stat
        sizes every file (chroma sizes a folder's pages on its first stat).

        Args:
            row (FileStat | None): the row the stored listings hold.
        """
        if (
            row is not None
            and row.size is None
            and row.type is FileType.FILE
            and self.vfs.sizes_always_known
        ):
            return None
        return row

    def _note_live(
        self,
        scope: PathSpec,
        index: IndexCacheStore,
        fn: Callable[..., Any],
        result: Any,
    ) -> None:
        """Under ``fresh``, keep a stat the backend answered as the
        running command's probe answer: the cache gate would ask the
        backend the same question again. Only a stat that asked the
        backend counts: one that takes neither an index of its own nor a
        row the mount hands it, either of which a listing filled.

        Args:
            scope (PathSpec): the stat's path, keyed below the mount.
            index (IndexCacheStore): the index the stat ran under; a
                probe's own store records through the probe.
            fn (Callable[..., Any]): the function that answered.
            result (Any): what the backend answered.
        """
        manager = self.cache_manager
        if (
            manager is not None
            and self.read.policy is ReadPolicy.FRESH
            and isinstance(result, FileStat)
            and not isinstance(index, ListingCheckStore)
            and self._lists
            and not _wants(self._backend_fn(fn))
        ):
            manager.note_probed(scope, result)

    @property
    def _names_only(self) -> bool:
        """Whether a kept listing vouches for its children's names only.

        A folder's version moves when its names change, not when a child
        is edited in place, so under ``fresh`` a mount whose listings are
        checked by folder answers a child's stat from its listing only
        when the running command listed it.
        """
        return (
            self.read.policy is ReadPolicy.FRESH
            and self.vfs.listing_version == ListingVersion.FOLDER
        )

    def _listing_lock(
        self, name: str, scope: PathSpec, index: IndexCacheStore
    ) -> AbstractAsyncContextManager[None]:
        """One listing of a folder at a time: a reader arriving while
        another lists it waits, then answers from what that one kept.

        Args:
            name (str): the op about to run.
            scope (PathSpec): its path, keyed below the mount.
            index (IndexCacheStore): the mount's index.
        """
        if name != "readdir" or not self._lists:
            return nullcontext()
        return index_lock(index, index_key(self.prefix, scope))

    async def _kept(
        self, name: str, scope: PathSpec, index: IndexCacheStore, result: Any
    ) -> Any:
        """What a listing or a subtree read answered, kept as listings.

        A listing answers its children's paths once kept.

        Args:
            name (str): the op that answered.
            scope (PathSpec): its path, keyed below the mount.
            index (IndexCacheStore): the mount's index.
            result (Any): the answer.
        """
        key = index_key(self.prefix, scope)
        if name == "readdir":
            return await keep_listing(index, key, result)
        if name == "read_tree" and isinstance(result, dict):
            await keep_tree(index, key, result)
            return {path: row for path, row in result.items() if path}
        return result

    async def _run(
        self,
        name: str,
        fn: Callable[..., Any],
        scope: PathSpec,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        op_timeout: float | None,
        found: dict[str, FileStat | None] | None = None,
    ) -> Any:
        """Run one function with the stats it declares.

        A stat a stored listing handed in may be stale: the backend
        answering ENOENT for it drops the listings it came from, which
        lists them again, and the function runs once more. A function
        handed nothing is not run again, nor a stat the listings found
        nothing at: the backend agrees with them.

        Args:
            name (str): the op name.
            fn (Callable[..., Any]): the function.
            scope (PathSpec): its path, keyed below the mount.
            args (tuple[Any, ...]): its positionals after the path.
            kwargs (dict[str, Any]): its keywords, ``index`` among them.
            op_timeout (float | None): the op's timeout.
            found (dict[str, FileStat | None] | None): the stats already
                found for ``fn``, None to find them here.
        """
        index = kwargs["index"]
        handed = (
            found
            if found is not None
            else await self._handed(fn, scope, kwargs, index)
        )
        try:
            return await self._invoke(
                name, fn, scope, args, {**kwargs, **handed}, op_timeout
            )
        except FileNotFoundError as exc:
            if all(stat is None for stat in handed.values()) or (
                name == "stat" and handed.get("entry") is None
            ):
                raise
            logger.debug(
                "%s %s missed its handed rows, asking again: %s",
                name,
                scope.virtual,
                exc,
            )
        await self._forget(scope, kwargs, index)
        handed = await self._handed(fn, scope, kwargs, index)
        return await self._invoke(
            name, fn, scope, args, {**kwargs, **handed}, op_timeout
        )

    async def _invoke(
        self,
        name: str,
        fn: Callable[..., Any],
        scope: PathSpec,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        op_timeout: float | None,
    ) -> Any:
        """Call one function with the keywords it takes, under the op's
        timeout.

        Args:
            name (str): the op name.
            fn (Callable[..., Any]): the function.
            scope (PathSpec): its path, keyed below the mount.
            args (tuple[Any, ...]): its positionals after the path.
            kwargs (dict[str, Any]): the keywords on offer.
            op_timeout (float | None): the op's timeout.
        """
        result = fn(scope, *args, **_taken(name, fn, kwargs))
        if inspect.isawaitable(result):
            result = await run_with_timeout(result, op_timeout, name)
        return result

    async def _forget(
        self, scope: PathSpec, kwargs: dict[str, Any], index: IndexCacheStore
    ) -> None:
        """Drop the listings a stale stat was handed from.

        Args:
            scope (PathSpec): the op's path, keyed below the mount.
            kwargs (dict[str, Any]): its keywords; a ``dst`` is forgotten
                too.
            index (IndexCacheStore): the mount's index.
        """
        paths = [scope]
        dst = kwargs.get("dst")
        if isinstance(dst, PathSpec):
            paths.append(self._scope(dst.virtual))
        for path in paths:
            key = index_key(self.prefix, path)
            await index.invalidate_dir(folder_of(key))
            await index.invalidate_dir(key)

    @overload
    async def call(
        self,
        name: Literal["stat"],
        path: str | PathSpec,
        /,
        *args: Any,
        **kwargs: Any,
    ) -> FileStat: ...

    @overload
    async def call(
        self,
        name: Literal["readdir"],
        path: str | PathSpec,
        /,
        *args: Any,
        **kwargs: Any,
    ) -> list[str]: ...

    @overload
    async def call(
        self,
        name: str,
        path: str | PathSpec,
        /,
        *args: Any,
        **kwargs: Any,
    ) -> Any: ...

    async def call(
        self,
        name: str,
        path: str | PathSpec,
        /,
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        """Run an op on this mount's VFS.

        Tries a rendered filetype's renderer first for a read, then the
        VFS's own function; the first answer that is not None wins. Each
        function is handed the keywords it takes, ``index`` among them.

        A caller may override the filetype by passing one, and passing
        None asks for the stored bytes even where the VFS renders the
        filetype. That is what a read-modify-write needs: it hands
        whatever it read straight back to ``write``, which always stores,
        so reading a rendered form would store the rendering over the
        file. A VFS with no ``read`` of its own (gdocs, gsheets, gslides)
        stores the rendering, so its stored bytes are the renderer's.
        TypeScript spells the same override ``read(path, {raw: true})``.
        A ``read_tree`` of one level (``level=True``) is the mount's own
        listing with each child's row (``_level``).

        Args:
            name (str): operation name (e.g. "read", "stat").
            path (str | PathSpec): virtual path; a listing of a glob word
                lists its directory for the pattern.
        """
        virtual = path if isinstance(path, str) else path.virtual
        if name == "read_tree" and kwargs.pop("level", False):
            return await self._level(virtual, kwargs.get("limit"))
        async with self.use():
            filetype = (
                kwargs.pop("filetype")
                if "filetype" in kwargs
                else get_extension(virtual)
            )
            if filetype is None and not self.vfs.supports("read"):
                filetype = get_extension(virtual)
            levels = self._callers(name, filetype)
            if not levels:
                # A copy only reads its source, so the path it is refused
                # at is the destination it would have made.
                mark = declared(type(self.vfs), name)
                dst = kwargs.get("dst")
                raise enotsup(
                    str(self.vfs.name),
                    name,
                    dst
                    if mark is not None
                    and mark.effect is Effect.COPY
                    and isinstance(dst, PathSpec)
                    else virtual,
                )
            self.require_writable(
                name, PathSpec.from_str_path(virtual), kwargs.values()
            )

            scope = self._scope(path)
            kwargs.setdefault("index", self.index)
            index = kwargs["index"]
            op_timeout = self.op_timeout(name)
            token = bind_caller(self._on_mount(current_caller()))
            try:
                # The backend's own paths are host paths, so the process
                # patch (runtime/python/host/fs.py and open.py) must not answer
                # them: a disk mount rooted at its own virtual prefix
                # spells the two the same, and routing the physical one
                # hands the op back to the backend serving it.
                with host_io():
                    async with self._listing_lock(name, scope, index):
                        handed: dict[str, FileStat | None] | None = None
                        if name in STORED_OPS and self._lists:
                            stored = await self._stored(name, scope, index)
                            if stored is None and name == "readdir":
                                # Finding the rows a listing is handed lists
                                # its parent, whose fetch may have proved this
                                # listing too (a seed).
                                handed = await self._handed(
                                    levels[0], scope, kwargs, index
                                )
                                stored = await self._stored(name, scope, index)
                            if stored is not None:
                                return stored
                        for fn in levels:
                            result = await self._run(
                                name,
                                fn,
                                scope,
                                args,
                                kwargs,
                                op_timeout,
                                handed,
                            )
                            handed = None
                            if result is None:
                                continue
                            if self._lists:
                                result = await self._kept(
                                    name, scope, index, result
                                )
                            if name == "stat":
                                self._note_live(scope, index, fn, result)
                            return _wrap_stream(
                                result, self.mount_id, self.activity
                            )
                return None
            finally:
                reset_caller(token)

    def _on_mount(self, caller: Caller) -> Caller:
        """``caller`` running on this mount: its records name this mount,
        its writes are checked against this mount's write context, and its
        reads keep this mount's revision pins.

        Args:
            caller (Caller): who makes the call.
        """
        return caller.changed(
            {
                "revisions": self.revisions or None,
                "recorder": None
                if caller.recorder is None
                else dataclasses.replace(
                    caller.recorder, mount_id=self.mount_id
                ),
                "write_context": self.write_context(),
            }
        )

    def _scope(self, path: str | PathSpec) -> PathSpec:
        """``path`` as this mount's VFS addresses it. A directory a glob
        walk lists for a pattern (``PathSpec.dir`` shaped) keeps the
        pattern, which a backend whose listing is a window moves the
        window by; a glob word left as typed names no directory.

        Args:
            path (str | PathSpec): virtual path.
        """
        prefix = self.prefix.rstrip("/")
        if (
            isinstance(path, PathSpec)
            and path.pattern is not None
            and path.virtual.rstrip("/") == path.directory.rstrip("/")
        ):
            folder = path.virtual.rstrip("/") or "/"
            return PathSpec(
                virtual=folder,
                directory=folder,
                vfs_path=mount_key(folder, prefix),
                pattern=path.pattern,
                resolved=False,
            )
        virtual = path if isinstance(path, str) else path.virtual
        return PathSpec(
            virtual=virtual,
            directory=virtual.rsplit("/", 1)[0] or "/",
            vfs_path=mount_key(virtual, prefix),
        )

    def op_timeout(self, name: str) -> float | None:
        """The op entry's timeout for ``name``, None for none.

        A file call is never cut: only the op entry's timeout applies,
        bounding the backend call itself.

        Args:
            name (str): operation name.
        """
        override = self.command_limits.get(name)
        return override.timeout_seconds if override is not None else None

    async def can_copy_from(self, source: "MountEntry", src: str) -> bool:
        """Whether this mount's store may copy ``src`` from ``source``'s,
        store to store.

        Not when this mount's VFS cannot copy from that one, nor when the
        store's object is not what a move's read and write would carry: a
        cached, pinned or rendered source reads other bytes, and a
        conditional mount on either end holds a version for the write or
        for ``mv``'s delete. Asked before the copy's deadline starts.

        Args:
            source (MountEntry): the mount ``src`` is on.
            src (str): the source's virtual path, on ``source``.
        """
        manager = source.cache_manager
        return not (
            not self.vfs.supports("copy_from")
            or WritePolicy.CONDITIONAL in (self.write, source.write)
            or src in source.revisions
            or source.renders(get_extension(src))
            or (
                manager is not None
                and await manager.is_cached(source._scope(src))
            )
        )

    async def copy_from(
        self, source: "MountEntry", src: str, dst: str
    ) -> None:
        """Copy a file from ``source``'s store into this mount's, store to
        store, under the mount's ``copy`` timeout.

        For ``cp`` and ``mv`` between two mounts, once the dispatcher
        has judged ``src`` as a read and ``dst`` as a create and
        ``can_copy_from`` has said yes. The VFS raises EXDEV when it
        cannot make the copy after all, and the caller moves the bytes
        itself.

        Args:
            source (MountEntry): the mount ``src`` is on.
            src (str): the source's virtual path, on ``source``.
            dst (str): the destination's virtual path, on this mount.
        """
        async with self.use(), source.use():
            self.require_writable("write", PathSpec.from_str_path(dst), ())
            await self._framed(
                "copy",
                lambda: self.vfs.copy_from(
                    source.vfs, source._scope(src), self._scope(dst)
                ),
            )

    async def search_many(
        self, paths: list[str], query: SearchQuery
    ) -> list[tuple[str, str]] | None:
        """Rank several scopes on this mount as one query, under the
        mount's ``search`` timeout.

        For the dispatcher, once it has walked, followed and admitted
        each scope as it does a ``search``'s one.

        Args:
            paths (list[str]): the scopes, as virtual paths.
            query (SearchQuery): the query and its options.
        """
        async with self.use():
            return await self._framed(
                "search",
                lambda: self.vfs.search_many(
                    [self._scope(p) for p in paths], query
                ),
            )

    async def read_many(
        self, paths: list[str], limit: int
    ) -> dict[str, bytes]:
        """Read several whole files on this mount in one request, under
        the mount's ``read`` timeout.

        For the dispatcher's read-ahead, once it has walked and followed
        each path; keyed by virtual path, a file left out is read on its
        own later.

        Args:
            paths (list[str]): the files, as virtual paths.
            limit (int): the most bytes worth fetching for one file.
        """
        async with self.use():
            return await self._framed(
                "read",
                lambda: self._read_many(
                    [self._scope(p) for p in paths], limit
                ),
            )

    async def _framed(self, op: str, work: Callable[[], Awaitable[T]]) -> T:
        """Run one backend call as ``call`` frames its own: as the caller
        on this mount (``_on_mount``), past the host-I/O patch, under the
        op's timeout.

        Args:
            op (str): the op whose timeout bounds the call.
            work (Callable[[], Awaitable[T]]): starts the call.
        """
        token = bind_caller(self._on_mount(current_caller()))
        try:
            with host_io():
                return await run_with_timeout(work(), self.op_timeout(op), op)
        finally:
            reset_caller(token)

    async def _read_many(
        self, scopes: list[PathSpec], limit: int
    ) -> dict[str, bytes]:
        """The VFS's batch read, handed what is at each path and at its
        folder as the stored listings name them, where it takes them.

        Args:
            scopes (list[PathSpec]): the files, keyed below the mount.
            limit (int): the most bytes worth fetching for one file.
        """
        fn = self.vfs.read_many
        names = _parameters(getattr(fn, "__func__", fn))
        kwargs: dict[str, list[FileStat | None]] = {}
        if names is None or "entries" in names:
            kwargs["entries"] = [
                await self._entry(s, self.index) for s in scopes
            ]
        if names is None or "parents" in names:
            kwargs["parents"] = [
                await self._entry(self._folder(s), self.index) for s in scopes
            ]
        return await fn(scopes, limit, **kwargs)

    def live_pipe(self, path: str) -> DevicePipe | None:
        """The live pipe a read of ``path`` takes bytes from, which another
        task is still writing.

        Args:
            path (str): virtual path.
        """
        accessor = getattr(self.vfs, "accessor", None)
        if not isinstance(accessor, RAMAccessor):
            return None
        key = norm("/" + mount_key(path, self.prefix.rstrip("/")))
        return active_pipe(accessor, key)

    def holds_live_pipe(self, path: str) -> bool:
        """Whether a live pipe sits at ``path`` or below it.

        Args:
            path (str): virtual path.
        """
        accessor = getattr(self.vfs, "accessor", None)
        if not isinstance(accessor, RAMAccessor):
            return False
        key = norm("/" + mount_key(path, self.prefix.rstrip("/")))
        return pipe_below(accessor, key)

    async def _streamed(
        self, scope: PathSpec, index: IndexCacheStore
    ) -> AsyncIterator[bytes]:
        """The VFS's read of ``scope`` as a stream, called on the first
        pull and handed the stats it declares.

        Args:
            scope (PathSpec): the file, keyed below the mount.
            index (IndexCacheStore): the mount's index.
        """
        source = _as_stream(await self._answer(index, scope))
        try:
            async for chunk in source:
                yield chunk
        finally:
            await close_quietly(source)

    def read_stream(self, path: str) -> AsyncIterator[bytes]:
        """The VFS's streamed read of ``path``, framed for later pulls.

        The backend runs on each pull, after this frame is gone, so every
        pull gets what ``call`` sets up around one call: the caller's
        context (session, recorder), the mount's recording and write
        contexts, its revision pins, the host-I/O bypass, and the read's
        timeout, which bounds each pull rather than the whole stream. The
        mount is held until the stream ends or is closed. A read that is
        neither a coroutine nor handed stats is called as the stream opens,
        so what it binds (a pipe) is bound before the path can be released.

        Args:
            path (str): virtual path.
        """
        if self.retiring:
            raise ebusy(self.prefix)
        scope = PathSpec(
            virtual=path,
            directory=path.rsplit("/", 1)[0] or "/",
            vfs_path=mount_key(path, self.prefix.rstrip("/")),
        )
        read = self.vfs.read
        source = (
            self._streamed(scope, self.index)
            if _wants(read) or inspect.iscoroutinefunction(read)
            else _as_stream(read(scope, **_handed_on(read, self.index)))
        )
        limit = self.command_limits.get("read")
        stream = with_pull_timeout(
            source,
            limit.timeout_seconds if limit is not None else None,
            "read",
        )
        caller = self._on_mount(current_caller())
        return cast(
            AsyncIterator[bytes],
            self.activity.hold(with_caller(with_host_io(stream), caller)),
        )
