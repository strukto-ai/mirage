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
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Callable

from mirage.cache.context import push_cache_manager
from mirage.cache.index import NULL_INDEX
from mirage.cache.index.config import IndexConfig
from mirage.cache.index.factory import build_index
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.generic_bind.adapter import command_io
from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.commands.builtin.utils.paths import dispatch_stat, link_follow
from mirage.commands.config import Command, CommandOpts, ExecContext
from mirage.commands.errors import CommandTimeoutError, UsageError
from mirage.commands.resolve import get_extension
from mirage.commands.spec import CommandSpec
from mirage.commands.spec.constants import (
    STDIN_DASH_COMMANDS,
    STDIN_DASH_LEADING,
)
from mirage.commands.spec.flag_view import FlagBag
from mirage.commands.spec.standard import has_injected_version
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import read_fail_exit_code
from mirage.context import (
    effective_mount_mode,
    require_paths_writable,
    reset_mount_gate,
    reset_walk_probe,
    set_mount_gate,
    set_walk_probe,
    strongest_mode_under,
)
from mirage.core.generic.rewrite import (
    append_by_rewrite,
    expect_offset,
    pwrite_by_rewrite,
    refuse_taken,
)
from mirage.errors.fs import ebusy, enotsup
from mirage.errors.render import format_fs_error
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.observe.context import (
    push_mount_context,
    push_revisions,
    reset_active_recorder,
    reset_revisions,
    with_mount_context,
    with_revisions,
)
from mirage.policy import resolve_limit
from mirage.runtime.python.host.host_io import host_io, with_host_io
from mirage.shell.bytes import encode_text
from mirage.types import (
    FileType,
    Limit,
    MountMode,
    PathSpec,
    Producer,
    ReadSpec,
    WalkProbe,
)
from mirage.utils.context_scope import ContextScope
from mirage.utils.ids import uuid7
from mirage.utils.key_prefix import mount_key
from mirage.utils.ranges import is_unsatisfiable_range, slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.call import call_effect
from mirage.vfs.constants import WRITE_EFFECTS
from mirage.vfs.types import Effect
from mirage.view.types import StatPath
from mirage.workspace.mount.activity import VFSActivity
from mirage.workspace.mount.read_policy import coerce_read_policy

logger = logging.getLogger(__name__)


async def _command_output(
    source: AsyncIterator[bytes],
    io: IOResult,
    command: str,
    paths: list[PathSpec],
) -> AsyncIterator[bytes]:
    """Keep a deferred backend failure on its command, after any emitted bytes.

    Args:
        source (AsyncIterator[bytes]): mount-owned output.
        io (IOResult): result finalized when the stream is exhausted.
        command (str): command whose diagnostic and exit code apply.
        paths (list[PathSpec]): operands for diagnostic spelling.
    """
    try:
        async for chunk in source:
            yield chunk
    except CommandTimeoutError:
        raise
    except Exception as exc:
        logger.debug("%s output failed", command, exc_info=True)
        existing = await materialize(io.stderr) or b""
        io.stderr = existing + format_fs_error(command, exc, paths)
        io.exit_code = (
            exc.exit_code
            if isinstance(exc, UsageError)
            else read_fail_exit_code(command, exc)
        )


def _wrap_mount_streams(
    result: tuple[ByteSource | None, IOResult],
    revisions: dict[str, str] | None,
    mount_id: str | None = None,
    activity: VFSActivity | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Wrap any async-iterator streams in ``result`` with the mount
    identity and active revisions, so ``record_stream`` and
    ``revision_for`` calls inside the lazy backend body see the right
    context when consumed after this frame exits.

    Mirrors the ``exit_on_empty`` pattern: thin async-gen wrapper that
    side-effects the recorder state as bytes flow through. Same object
    appearing in both the primary stream and IOResult.reads/writes is
    wrapped once (dedup by identity).

    Args:
        result: ``(stream, io)`` as returned by a command handler.
        revisions: revisions map to push during stream consumption
            (None when the mount has no pins installed).
        mount_id (str | None): identity of the serving mount.
    """
    stream, io = result
    seen: dict[int, ByteSource] = {}
    scope = ContextScope()

    def _wrap(obj: ByteSource) -> ByteSource:
        if isinstance(obj, (bytes, bytearray)):
            return obj
        oid = id(obj)
        if oid in seen:
            return seen[oid]
        source = obj.source if isinstance(obj, CachableAsyncIterator) else obj
        wrapped = with_mount_context(source, mount_id)
        if revisions:
            wrapped = with_revisions(revisions, wrapped)
        wrapped = scope.stream(with_host_io(wrapped))
        if isinstance(obj, CachableAsyncIterator):
            obj.replace_source(wrapped)
            wrapped = obj
        held = activity.hold(wrapped) if activity is not None else wrapped
        seen[oid] = held
        return held

    stream = _wrap(stream) if stream is not None else None
    for k, v in list(io.reads.items()):
        io.reads[k] = _wrap(v)
    for k, v in list(io.writes.items()):
        io.writes[k] = _wrap(v)
    return stream, io


def _wrap_stream(result: Any, mount_id: str, activity: VFSActivity) -> Any:
    """Hold the host-I/O bypass around an op result that streams.

    An op that returns an async iterator has not run its body yet: the
    backend opens the file on the first ``__anext__``, after the frame
    that called it (and its ``host_io`` scope) is gone. Same reason
    ``_wrap_mount_streams`` re-establishes the recorder state.

    Args:
        result (Any): whatever the op returned.
        mount_id (str): identity of the serving mount.
    """
    if isinstance(result, CachableAsyncIterator):
        result.replace_source(
            with_host_io(with_mount_context(result.source, mount_id))
        )
        return activity.hold(result)
    if hasattr(result, "__aiter__"):
        return activity.hold(
            with_host_io(with_mount_context(result, mount_id))
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

    The mount hands every function its ``index``; a function that does
    not name it never sees it. Every other keyword is the caller's, and
    one the function does not take is the TypeError a direct call would
    raise, never silently dropped.

    Args:
        name (str): the function the caller named, which the error names.
        fn (Callable[..., Any]): the function about to run.
        kwargs (dict[str, Any]): the call's keywords.
    """
    target = fn.func if isinstance(fn, functools.partial) else fn
    names = _parameters(getattr(target, "__func__", target))
    if names is None:
        return kwargs
    unknown = sorted(set(kwargs) - names - {"index"})
    if unknown:
        raise TypeError(
            f"{name}() got an unexpected keyword argument {unknown[0]!r}"
        )
    return {k: v for k, v in kwargs.items() if k in names}


async def _read_window(
    read: Callable[..., Awaitable[bytes]],
    ranges: bool,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
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
        read (Callable[..., Awaitable[bytes]]): the VFS's read, or the
            renderer for the path's filetype.
        ranges (bool): whether ``read`` takes a window natively.
        path (PathSpec): the file.
        index (IndexCacheStore): the mount's index.
        offset (int): the window's first byte.
        size (int | None): the window's length, None through the end.
    """
    if size == 0:
        return b""
    whole = not offset and size is None
    if ranges and not whole:
        try:
            return await read(path, index=index, offset=offset, size=size)
        except Exception as exc:
            if not is_unsatisfiable_range(exc):
                raise
            return b""
    data = await read(path, index=index)
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
        self.visible: Callable[[], bool] | None = None
        self.mount_id = uuid7()
        self.prefix = prefix
        self.vfs = vfs
        # The command tier's table, built once from the VFS's functions.
        self.io = command_io(vfs)
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
        self.activity = VFSActivity()
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
        self._general_cmds: dict[str, Command] = {}
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

    async def expand_glob(
        self, paths: list[PathSpec], prefix: str
    ) -> list[PathSpec]:
        """Expand glob words through the VFS's ``readdir``, one at a time.

        A VFS with no ``readdir`` leaves every word as typed. The mount
        stamps each word's mount-relative key before the walk sees it,
        since the key is the placement's to know, and keeps the VFS
        retained while the walk reads metadata.

        Args:
            paths (list[PathSpec]): the words, pattern specs among them.
            prefix (str): the mount prefix without its trailing slash.
        """
        if not self.vfs.supports("readdir"):
            return list(paths)
        async with self.use():
            if self.cache_manager is None:
                return await self._run_glob(paths, prefix, self.index_store)
            async with self.cache_manager.mutation():
                await self.ensure_ready()
                index = self.cache_manager.scope_index_locked(self.index_store)
                return await self._run_glob(paths, prefix, index)

    async def _run_glob(
        self,
        paths: list[PathSpec],
        prefix: str,
        index: IndexCacheStore,
    ) -> list[PathSpec]:
        out: list[PathSpec] = []
        for p in paths:
            spec = (
                dataclasses.replace(p, vfs_path=mount_key(p.virtual, prefix))
                if prefix
                else p
            )
            out.extend(await self._glob(spec, index))
        return out

    async def _glob(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[PathSpec]:
        """Expand one pattern through the VFS's ``readdir`` and ``stat``.

        Args:
            path (PathSpec): the pattern, keyed below the mount.
            index (IndexCacheStore): the mount's index.
        """
        return await self.io.resolve_glob(self.vfs.accessor, [path], index)

    @property
    def index(self) -> IndexCacheStore:
        index = self.index_store
        return (
            self.cache_manager.scope_index(index)
            if self.cache_manager
            else index
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
        """Register a VFS-specific command."""
        key = (cmd.name, cmd.filetype)
        self._cmds[key] = cmd
        if cmd.spec is not None:
            self._cmd_specs[cmd.name] = cmd.spec
        self._prefix_index = None

    def register_general(
        self,
        cmd: Command,
    ) -> None:
        """Register a general command (vfs=None).

        General commands work on any VFS (e.g. echo, pwd).
        They are the last fallback in resolve_command().
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
        3. general_cmds[cmd_name] -- general fallback
        """
        if extension:
            cmd = self._cmds.get((cmd_name, extension))
            if cmd is not None:
                return cmd
        cmd = self._cmds.get((cmd_name, None))
        if cmd is not None:
            return cmd
        return self._general_cmds.get(cmd_name)

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
        """Register decorated functions or command definitions.

        Args:
            fns (iterable): Decorated functions or Command
                values.

        Raises:
            ValueError: If a command's VFS doesn't match this mount's VFS.
        """
        pname = self.vfs.name
        # Grouped by name, because a family table fans out over sibling
        # VFS names, so most entries a mount is handed may belong to a
        # sibling and are simply skipped. A name whose entries name only
        # other VFS is the real mistake (a table built for the wrong
        # backend), and that still raises.
        cmd_groups: dict[str, tuple[list[Command], set[str]]] = {}
        for fn in fns:
            rcs: list[Command] = (
                [fn]
                if isinstance(fn, Command)
                else getattr(fn, "_registered_commands", [])
            )
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
        for keep, _attempted in cmd_groups.values():
            for rc in keep:
                self.register(rc)

    def unregister(self, names: list[str]) -> None:
        """Remove all commands with the given names.

        Args:
            names (list[str]): Command names to remove.
        """
        for name in names:
            keys = [k for k in self._cmds if k[0] == name]
            for k in keys:
                del self._cmds[k]
            self._general_cmds.pop(name, None)
            self._cmd_specs.pop(name, None)

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

    def writes(self, name: str) -> bool:
        """Whether the VFS declares the function ``op_name`` a write.

        Args:
            name (str): the op name.
        """
        return call_effect(type(self.vfs), name) in WRITE_EFFECTS

    def require_writable(
        self, name: str, path: PathSpec, values: Iterable[Any]
    ) -> None:
        """Refuse a write the mount's mode does not grant at every path.

        Every path the call is handed is one it may change: a rename's
        destination, a custom function's other paths. A rename mutates
        everything under its endpoints in one backend call, so a
        read-only region below either one refuses it too. Removals stay
        per-path: the runtimes compose rmtree from unlink and rmdir, and
        each answers for its own path.

        Args:
            name (str): the function name.
            path (PathSpec): the path the call names.
            values (Iterable[Any]): the call's other arguments; each
                PathSpec among them is a path it reaches.
        """
        effect = call_effect(type(self.vfs), name)
        if effect not in WRITE_EFFECTS:
            return
        require_paths_writable(
            [path, *(v for v in values if isinstance(v, PathSpec))],
            self.prefix,
            self.mode,
            subtree=effect is Effect.RENAME,
        )

    def refuse_keywords(self, name: str, kwargs: dict[str, Any]) -> None:
        """Refuse a keyword the function ``name`` does not take.

        The door asks before it answers a read from the cache, so a warm
        read is judged by what a cold one runs, the mount's read window
        included, and refuses the keyword a cold one would.

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
        context: ExecContext = ExecContext(),
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
            context (ExecContext): the invocation's execution context —
                everything the workspace supplies beyond the parsed line
                (the fifth argument TypeScript's ``runCommand`` has
                always taken); re-boxed whole onto ``CommandOpts``
                beside the facts only this mount can supply. A handler
                reads the fields it wants, so no list of command names
                is kept here.
        """
        async with self.use():
            handlers = await self._pick_handlers(
                cmd_name, paths, context.stat_path
            )
            if not handlers:
                return None, IOResult(
                    exit_code=127,
                    stderr=encode_text(f"{cmd_name}: command not found"),
                )
            paths = self._keyed_paths(cmd_name, paths)
            flags = self._keyed_flags(flag_kwargs)
            opts = self._command_opts(cmd_name, flags, context)
            with self._command_scope(context):
                for cmd in handlers:
                    refusal = self._read_only_refusal(cmd_name, cmd, flags)
                    if refusal is not None:
                        return None, refusal
                    result = await self._run_handler(
                        cmd_name, cmd, paths, texts, opts, context
                    )
                    if result is not None:
                        return self._wrap_output(cmd_name, cmd, paths, result)
                return None, IOResult()

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
        """Stamp this mount's backend key onto each path operand.

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

    def _command_opts(
        self,
        cmd_name: str,
        flags: dict[str, FlagValue],
        context: ExecContext,
    ) -> CommandOpts:
        """The one typed bag a handler reads, built here and nowhere else.

        A handler reads the fields it wants and ignores the rest, so there
        is no opt-in registry (mirrors Mount.runCommand building
        CommandOpts).

        Args:
            cmd_name (str): command name.
            flags (dict[str, FlagValue]): the keyed flags.
            context (ExecContext): the invocation's execution context.
        """
        mount_prefix = self.prefix.rstrip("/")
        cwd = context.cwd
        return CommandOpts(
            command=cmd_name,
            stdin=context.stdin,
            flags=flags,
            cwd=PathSpec(
                virtual=cwd,
                directory=cwd,
                resolved=False,
                vfs_path=mount_key(cwd, mount_prefix),
            ),
            mount_prefix=mount_prefix,
            index=self.index,
            io=self.io,
            dispatch=context.dispatch,
            session_id=context.session_id,
            env=context.env,
            exec_allowed=context.exec_allowed,
            exec_path_allowed=context.exec_path_allowed,
            runtime=context.runtime,
            runtime_unavailable=context.runtime_unavailable,
            ns=context.ns,
            stat_path=context.stat_path,
            readdir_path=context.readdir_path,
            session_view=context.session_view,
            processes=context.processes,
            shell=context.shell,
            argv=context.argv,
        )

    @contextmanager
    def _command_scope(self, context: ExecContext) -> Iterator[None]:
        """Bind what a handler's backend calls read from the context.

        The recorder's mount, the snapshot revision pins and the mount's
        cache manager; the mode the command tier's mode guard holds each
        write to (its own region's mode); and what the command tier's
        walk guard proves an operand's `.` and `..` with: the handler
        reaches its backend past the door, so the door's stat and link
        follow are bound here.

        Args:
            context (ExecContext): the invocation's execution context.
        """
        recording_token = push_mount_context(self.mount_id)
        revs_token = push_revisions(self.revisions or None)
        prev_manager = push_cache_manager(self.cache_manager)
        gate_token = set_mount_gate(self.prefix, self.mode)
        links = context.ns.links if context.ns is not None else None
        walk_token = (
            set_walk_probe(
                WalkProbe(
                    stat=functools.partial(dispatch_stat, context.dispatch),
                    follow=link_follow(links),
                )
            )
            if context.dispatch is not None
            else None
        )
        try:
            yield
        finally:
            if walk_token is not None:
                reset_walk_probe(walk_token)
            reset_mount_gate(gate_token)
            reset_revisions(revs_token)
            reset_active_recorder(recording_token)
            push_cache_manager(prev_manager)

    def _read_only_refusal(
        self,
        cmd_name: str,
        cmd: Command,
        flags: dict[str, FlagValue],
    ) -> IOResult | None:
        """Refuse a write command no door would see, on a read-only mount.

        A command whose I/O runs under the path guards is refused where
        it writes, because only the write knows whether a line writes:
        `gzip -c`, `tar -t` and `split -n 1/2` read a read-only mount like
        any reader, and `gzip f` is refused at the write of `f.gz`, in
        gzip's own GNU voice. A write command that reaches its service
        some other way (trello's id-addressed card writes, a custom
        backend's own verb) is refused here, before it runs, because no
        door would see its write. strongest_mode_under, not
        effective_mode: a mount whose only writable region is a show
        entry still runs it. Only wrapper-owned responses (help, an
        injected version) bypass it. The trailing newline is
        load-bearing: stderr accumulates across a line.

        Args:
            cmd_name (str): command name.
            cmd (Command): the handler about to run.
            flags (dict[str, FlagValue]): the keyed flags.
        """
        info_only = flags.get("help") is True or (
            flags.get("version") is True and has_injected_version(cmd.spec)
        )
        if (
            cmd.write
            and not cmd.path_guarded
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

    async def _run_handler(
        self,
        cmd_name: str,
        cmd: Command,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
        context: ExecContext,
    ) -> Any:
        """Run one handler under the mount-resolved timeout.

        The dispatch-level guard only sees default limits (the mount is
        unknown before routing), so the mount-resolved timeout must also
        bound the command body: eager commands do their work inside
        cmd.fn, where the stream-consumption guard never runs.

        Args:
            cmd_name (str): command name.
            cmd (Command): the handler to run.
            paths (list[PathSpec]): the keyed path operands.
            texts (list[str]): positional text args.
            opts (CommandOpts): the handler's options.
            context (ExecContext): the invocation's execution context.
        """
        resolved_limit = resolve_limit(
            cmd_name,
            command_default=cmd.limit,
            mount_override=context.limit_override
            or self.command_limits.get(cmd_name),
        )
        cmd_timeout = (
            resolved_limit.timeout_seconds
            if resolved_limit is not None
            else None
        )
        with host_io():
            return await run_with_timeout(
                cmd.fn(self.vfs.accessor, paths, texts, opts),
                cmd_timeout,
                cmd_name,
            )

    def _wrap_output(
        self,
        cmd_name: str,
        cmd: Command,
        paths: list[PathSpec],
        result: Any,
    ) -> tuple[ByteSource | None, IOResult]:
        """Frame a handler's answer as this mount's command output.

        Args:
            cmd_name (str): command name.
            cmd (Command): the handler that answered.
            paths (list[PathSpec]): the keyed path operands.
            result (Any): the handler's ``(stream, io)`` answer.
        """
        stream, io = _wrap_mount_streams(
            result,
            self.revisions or None,
            self.mount_id,
            self.activity,
        )
        io.producer = Producer(
            command=cmd_name,
            prefixes=(self.prefix,),
            declared=cmd.limit,
        )
        if stream is not None and not isinstance(stream, bytes):
            stream = _command_output(stream, io, cmd_name, paths)
        return stream, io

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
        The rest is the op door's own shape around the VFS's functions: a
        read takes a window, ``append`` and ``pwrite`` are a rewrite where
        the VFS only writes whole files, ``mkdir`` refuses a taken name
        first, and ``glob`` walks ``readdir``. Only a function marked
        ``@vfs_call`` is reachable by name.

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
        if name == "glob":
            return [self._glob] if vfs.supports("readdir") else []
        if name in ("append", "pwrite") and not vfs.supports(name):
            return (
                [getattr(self, f"_{name}_by_rewrite")]
                if vfs.supports("write")
                else []
            )
        if name == "pwrite":
            return [self._pwrite]
        if name == "mkdir" and vfs.supports("mkdir"):
            return [self._mkdir]
        if call_effect(type(vfs), name) is None or not vfs.supports(name):
            return []
        return [getattr(vfs, name)]

    async def _append_by_rewrite(
        self,
        path: PathSpec,
        data: bytes,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await append_by_rewrite(
            functools.partial(self.vfs.read, index=index),
            self.vfs.write,
            functools.partial(self.vfs.stat, index=index),
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
            functools.partial(self.vfs.read, index=index),
            self.vfs.write,
            functools.partial(self.vfs.stat, index=index),
            path,
            data,
            expect_offset(offset, path),
        )

    async def _pwrite(
        self,
        path: PathSpec,
        data: bytes,
        offset: int,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await self.vfs.pwrite(
            path, data, expect_offset(offset, path), index=index
        )

    async def _mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await refuse_taken(self.vfs.stat, path, parents)
        await self.vfs.mkdir(path, parents=parents)

    async def call(
        self,
        name: str,
        path: str,
        /,
        *args,
        **kwargs,
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
        file. TypeScript spells the same override
        ``readFile(path, {raw: true})``.

        Args:
            name (str): operation name (e.g. "read", "stat").
            path (str): virtual path.
        """
        async with self.use():
            filetype = (
                kwargs.pop("filetype")
                if "filetype" in kwargs
                else get_extension(path)
            )
            levels = self._callers(name, filetype)
            if not levels:
                raise enotsup(str(self.vfs.name), name, path)

            self.require_writable(
                name, PathSpec.from_str_path(path), kwargs.values()
            )

            mount_prefix = self.prefix.rstrip("/")
            scope = PathSpec(
                virtual=path,
                directory=path.rsplit("/", 1)[0] or "/",
                vfs_path=mount_key(path, mount_prefix),
            )
            kwargs.setdefault("index", self.index)
            # Per-op caps are policy and fire at the op doors (post_vfs);
            # only the timeout stays here, bounding the backend call itself.
            op_override = self.command_limits.get(name)
            op_timeout = (
                op_override.timeout_seconds
                if op_override is not None
                else None
            )
            recording_token = push_mount_context(self.mount_id)
            revs_token = push_revisions(self.revisions or None)
            try:
                for fn in levels:
                    # The backend's own paths are host paths, so the process
                    # patch (runtime/python/host/fs.py and open.py) must not answer
                    # them: a disk mount rooted at its own virtual prefix
                    # spells the two the same, and routing the physical one
                    # hands the op back to the backend serving it.
                    with host_io():
                        result = fn(scope, *args, **_taken(name, fn, kwargs))
                        if inspect.isawaitable(result):
                            result = await run_with_timeout(
                                result, op_timeout, name
                            )
                    if result is not None:
                        return _wrap_stream(
                            result, self.mount_id, self.activity
                        )
                return None
            finally:
                reset_revisions(revs_token)
                reset_active_recorder(recording_token)
