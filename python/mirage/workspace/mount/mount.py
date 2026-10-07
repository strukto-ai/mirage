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
from collections.abc import AsyncIterator, Awaitable, Iterable
from contextlib import asynccontextmanager
from typing import Any, Callable

from mirage.cache.context import push_cache_manager
from mirage.cache.index.config import IndexConfig
from mirage.cache.index.factory import build_index
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.commands.builtin.utils.paths import dispatch_stat, link_follow
from mirage.commands.config import CommandOpts, ExecContext, RegisteredCommand
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
    get_current_session,
    require_paths_writable,
    strongest_mode_under,
)
from mirage.context.types import IOContext
from mirage.errors.fs import ebusy, enotsup
from mirage.errors.render import format_fs_error
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.observe.context import (
    Recorder,
    active_recorder,
    push_mount_context,
    push_revisions,
    reset_active_recorder,
    reset_revisions,
    with_mount_context,
    with_revisions,
)
from mirage.ops.registry import RegisteredOp
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
from mirage.vfs.base import BaseVFS
from mirage.workspace.mount.activity import VFSActivity
from mirage.workspace.mount.read_policy import coerce_read_policy
from mirage.workspace.session.access import io_context

logger = logging.getLogger(__name__)

# Ops that mutate everything under their endpoints in one backend call
# (a directory rename relocates its whole subtree), so the door also
# refuses a read-only region below either endpoint. The removal ops
# stay per-path: the runtimes compose rmtree from unlink/rmdir, and
# each of those answers for its own path above.
_SUBTREE_OPS = frozenset({"rename"})


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


def _wrap_op_stream(result: Any, mount_id: str, activity: VFSActivity) -> Any:
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
        self.visible: Callable[[], bool] | None = None
        self.mount_id = uuid7()
        self.prefix = prefix
        self.vfs = vfs
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
        self._cmds: dict[tuple[Any, ...], RegisteredCommand] = {}
        self._general_cmds: dict[str, RegisteredCommand] = {}
        self._cmd_specs: dict[str, CommandSpec] = {}
        # first token -> descending token counts of multi-word command
        # names (e.g. "gws docs documents get"); backs longest-prefix
        # command resolution. None until first built; invalidated on
        # register.
        self._prefix_index: dict[str, list[int]] | None = None
        self.command_limits: dict[str, Limit] = {}
        self._ops: dict[tuple[Any, ...], RegisteredOp] = {}
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

    def has_op(self, name: str) -> bool:
        """Whether the op table serves ``name`` on any level of the cascade.

        Args:
            name (str): the op name.
        """
        return bool(self._resolve_cascade(name, None, self._ops))

    async def expand_glob(
        self,
        paths: list[PathSpec],
        prefix: str,
        io_context: IOContext | None = None,
    ) -> list[PathSpec]:
        """Expand glob words through the ``glob`` op, one spec at a time.

        A driver whose table carries no ``glob`` leaves every word as
        typed. The mount stamps each word's mount-relative key before the
        op sees it, since the key is the placement's to know, and keeps
        the VFS retained while the walk reads metadata.

        Args:
            paths (list[PathSpec]): the words, pattern specs among them.
            prefix (str): the mount prefix without its trailing slash.
        """
        levels = self._resolve_cascade("glob", None, self._ops)
        if not levels:
            return list(paths)
        async with self.use():
            if self.cache_manager is None:
                return await self._run_glob(
                    levels, paths, prefix, self.index_store, io_context
                )
            async with self.cache_manager.mutation():
                await self.ensure_ready()
                index = self.cache_manager.scope_index_locked(self.index_store)
                return await self._run_glob(
                    levels, paths, prefix, index, io_context
                )

    async def _run_glob(
        self,
        levels: list[RegisteredOp],
        paths: list[PathSpec],
        prefix: str,
        index: IndexCacheStore,
        io_context: IOContext | None = None,
    ) -> list[PathSpec]:
        out: list[PathSpec] = []
        for p in paths:
            spec = (
                dataclasses.replace(p, vfs_path=mount_key(p.virtual, prefix))
                if prefix
                else p
            )
            for op in levels:
                matches = await op.fn(
                    self.vfs.accessor, spec, index=index, io_context=io_context
                )
                if matches is not None:
                    out.extend(matches)
                    break
        return out

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

    def effective_mode(self, context: IOContext | None = None) -> MountMode:
        """This mount's mode narrowed by the current session's cap.

        The configured mode is the ceiling; a session's mode can only
        weaken it.
        """
        return effective_mount_mode(self.prefix, self.mode, context)

    # ── command registration ──────────────────────────

    def register(self, cmd: RegisteredCommand) -> None:
        """Register a VFS-specific command."""
        key = (cmd.name, cmd.filetype)
        self._cmds[key] = cmd
        if cmd.spec is not None:
            self._cmd_specs[cmd.name] = cmd.spec
        self._prefix_index = None

    def register_general(
        self,
        cmd: RegisteredCommand,
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
    ) -> RegisteredCommand | None:
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

    def all_commands(self) -> list[RegisteredCommand]:
        """All registered commands (per-mount + general), deduped by name."""
        seen: set[str] = set()
        out: list[RegisteredCommand] = []
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

    def filetype_handlers(
        self,
        cmd_name: str,
    ) -> dict[str, Callable[..., Any]]:
        """Get filetype-specific command handlers.

        Example::

            mount.register(generic_cat)   # ("cat", None)
            mount.register(parquet_cat)   # ("cat", ".parquet")

            mount.filetype_handlers("cat")
            # -> {".parquet": parquet_cat_fn}

        Args:
            cmd_name (str): command name, e.g. "cat".
        """
        fns: dict[str, Callable[..., Any]] = {}
        for (name, ft), rc in self._cmds.items():
            if name == cmd_name and ft is not None:
                if ft not in fns:
                    fns[ft] = rc.fn
        return fns

    def register_fns(self, fns: Iterable[Any]) -> None:
        """Register decorated functions or command/op definitions.

        Args:
            fns (iterable): Decorated functions, RegisteredCommand values,
                and/or RegisteredOp values.

        Raises:
            ValueError: If a command/op's VFS doesn't match
                this mount's VFS.
        """
        pname = self.vfs.name
        # Grouped by name, because a family table fans out over sibling
        # VFS names: hf_buckets/hf_datasets/hf_models/hf_spaces share one
        # `make_generic_ops(HF_VFS_NAMES, IO)` table, so most entries a
        # mount is handed belong to a sibling and are simply skipped. A
        # name whose entries name only other VFS is the real mistake (a
        # table built for the wrong backend), and that still raises.
        cmd_groups: dict[str, tuple[list[RegisteredCommand], set[str]]] = {}
        op_groups: dict[str, tuple[list[RegisteredOp], set[str]]] = {}
        for fn in fns:
            rcs: list[RegisteredCommand] = (
                [fn]
                if isinstance(fn, RegisteredCommand)
                else getattr(fn, "_registered_commands", [])
            )
            for rc in rcs:
                keep, attempted = cmd_groups.setdefault(rc.name, ([], set()))
                if rc.vfs is None or rc.vfs == pname:
                    keep.append(rc)
                else:
                    attempted.add(rc.vfs)
            ros: list[RegisteredOp] = (
                [fn]
                if isinstance(fn, RegisteredOp)
                else getattr(fn, "_registered_ops", [])
            )
            for ro in ros:
                keep_op, attempted_op = op_groups.setdefault(
                    ro.name, ([], set())
                )
                if ro.vfs is None or ro.vfs == pname:
                    keep_op.append(ro)
                else:
                    attempted_op.add(ro.vfs)
        for name, (keep, attempted) in cmd_groups.items():
            if not keep:
                raise ValueError(
                    f"command {name!r} is for VFS(s) "
                    f"{sorted(attempted)!r}, not {pname!r}"
                )
        for name, (keep_op, attempted_op) in op_groups.items():
            if not keep_op:
                raise ValueError(
                    f"op {name!r} is for VFS(s) "
                    f"{sorted(attempted_op)!r}, not {pname!r}"
                )
        for keep, _attempted in cmd_groups.values():
            for rc in keep:
                self.register(rc)
        for keep_op, _attempted_op in op_groups.values():
            for ro in keep_op:
                self.register_op(ro)

    def unregister(self, names: list[str]) -> None:
        """Remove all commands and ops with the given names.

        Args:
            names (list[str]): Command/op names to remove.
        """
        for name in names:
            keys = [k for k in self._cmds if k[0] == name]
            for k in keys:
                del self._cmds[k]
            self._general_cmds.pop(name, None)
            self._cmd_specs.pop(name, None)
            op_keys = [k for k in self._ops if k[0] == name]
            for k in op_keys:
                del self._ops[k]

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

    def registered_ops(self) -> dict[str, list[str | None]]:
        """List registered ops grouped by filetype variants.

        Returns:
            dict[str, list[str | None]]: Op name to filetype list.
        """
        result: dict[str, list[str | None]] = {}
        for name, filetype in self._ops:
            result.setdefault(name, []).append(filetype)
        for name in result:
            result[name] = sorted(
                result[name], key=lambda x: (x is not None, x or "")
            )
        return dict(sorted(result.items()))

    # ── op registration ───────────────────────────────

    def register_op(self, op: RegisteredOp) -> None:
        """Register a VFS-specific VFS op."""
        key = (op.name, op.filetype)
        self._ops[key] = op

    def has_filetype_op(self, name: str, filetype: str) -> bool:
        """Whether an op named ``name`` is registered for ``filetype``.

        Args:
            name (str): the op name.
            filetype (str): the extension the op is scoped to.
        """
        return (name, filetype) in self._ops

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

        False where the read op that answers it reads the whole file and
        slices: a backend with no native range, or a filetype-scoped
        render.

        Args:
            path (str): virtual path.
        """
        levels = self._resolve_cascade("read", get_extension(path), self._ops)
        return bool(levels) and levels[0].ranges

    # ── execution ─────────────────────────────────────

    async def execute_cmd(
        self,
        cmd_name: str,
        paths: list[PathSpec],
        texts: list[str],
        flag_kwargs: dict[str, FlagValue],
        context: ExecContext = ExecContext(),
    ) -> tuple[ByteSource | None, IOResult]:
        """Execute a command on this mount's VFS.

        Pure dispatch — flag parsing is done upstream in
        executor/command.py. This method just resolves the
        command handler and calls it.

        Args:
            cmd_name (str): command name.
            paths (list[PathSpec]): positional path args.
            texts (list[str]): positional text args.
            flag_kwargs (dict): parsed flags from upstream.
            context (ExecContext): the invocation's execution context —
                everything the workspace supplies beyond the parsed line
                (the fifth argument TypeScript's ``executeCmd`` has
                always taken); re-boxed whole onto ``CommandOpts``
                beside the facts only this mount can supply. A handler
                reads the fields it wants, so no list of command names
                is kept here.
        """
        async with self.use():
            bound_io = context.io_context or io_context(
                get_current_session(), recorder=active_recorder()
            )
            stdin = context.stdin
            cwd = context.cwd
            stat_path = context.stat_path
            extension = get_extension(paths[0].virtual) if paths else None
            # A filetype handler is selected from the operand's NAME, and a
            # directory can carry any extension, so the cascade would hand a
            # renderer a directory to read. One stat settles it, and only when
            # a handler for this exact extension exists, so a mount with no
            # filetype registrations never reaches the probe. The built-in is
            # what a directory should get: it owns GNU's `Is a directory`
            # wording, and the renderer owns nothing but its own format.
            # The DISPATCHER's stat, not the backend's, so a mount root and a
            # namespace-only directory answer too; None means neither plane
            # saw anything, in which case the renderer reports its own miss.
            if (
                extension is not None
                and paths
                and stat_path is not None
                and (cmd_name, extension) in self._cmds
            ):
                entry = await stat_path(paths[0].virtual)
                if entry is not None and entry.type == FileType.DIRECTORY:
                    extension = None

            handlers = self._resolve_cascade(
                cmd_name, extension, self._cmds, self._general_cmds
            )
            if not handlers:
                return None, IOResult(
                    exit_code=127,
                    stderr=encode_text(f"{cmd_name}: command not found"),
                )

            mount_prefix = self.prefix.rstrip("/")
            filetype_fns = self.filetype_handlers(cmd_name)
            is_filetype_cmd = (
                extension is not None and (cmd_name, extension) in self._cmds
            )

            # A stdin `-` routed nowhere, so it rides on whichever mount
            # runs the line, beside the operands that chose it.
            stdin_slots = (
                STDIN_DASH_LEADING.get(cmd_name, len(paths))
                if cmd_name in STDIN_DASH_COMMANDS
                else 0
            )
            paths = [
                dataclasses.replace(
                    p, virtual=f"{mount_prefix}/-", vfs_path="-"
                )
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

            # Stamp this mount's backend key onto path-shaped flag values so
            # backend reads can address them: a single PathSpec (e.g. awk -f,
            # single grep -f) or a list of PathSpec (multiple grep -f).
            # Everything else (bools, strings, list[str] like repeated -e) is
            # not a path and passes through unchanged.
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
                            item,
                            vfs_path=mount_key(item.virtual, mount_prefix),
                        )
                        for item in specs
                    ]
                else:
                    flags[k] = v
            # One typed bag, constructed here and nowhere else; a handler
            # reads the fields it wants and ignores the rest, so there is no
            # opt-in registry (mirrors Mount.executeCmd building CommandOpts).
            opts = CommandOpts(
                io_context=(
                    dataclasses.replace(
                        bound_io,
                        recorder=Recorder(
                            bound_io.recorder.sink, self.mount_id
                        )
                        if bound_io.recorder
                        else None,
                        mount_gate=(self.prefix, self.mode),
                        walk_probe=(
                            WalkProbe(
                                stat=functools.partial(
                                    dispatch_stat, context.dispatch
                                ),
                                follow=link_follow(
                                    context.ns.links if context.ns else None
                                ),
                            )
                            if context.dispatch
                            else None
                        ),
                    )
                ),
                command=cmd_name,
                stdin=stdin,
                flags=flags,
                cwd=PathSpec(
                    virtual=cwd,
                    directory=cwd,
                    resolved=False,
                    vfs_path=mount_key(cwd, mount_prefix),
                ),
                mount_prefix=mount_prefix,
                filetype_fns=(filetype_fns if not is_filetype_cmd else None),
                index=self.index,
                dispatch=context.dispatch,
                session_id=context.session_id,
                env=context.env,
                exec_allowed=context.exec_allowed,
                exec_path_allowed=context.exec_path_allowed,
                runtime=context.runtime,
                runtime_unavailable=context.runtime_unavailable,
                ns=context.ns,
                stat_path=stat_path,
                readdir_path=context.readdir_path,
                session_view=context.session_view,
                processes=context.processes,
                shell=context.shell,
                argv=context.argv,
            )

            recording_token = push_mount_context(self.mount_id)
            revs_token = push_revisions(self.revisions or None)
            prev_manager = push_cache_manager(self.cache_manager)
            try:
                for cmd in handlers:
                    # Only wrapper-owned responses bypass the write guard.
                    info_only = flags.get("help") is True or (
                        flags.get("version") is True
                        and has_injected_version(cmd.spec)
                    )
                    # A command whose I/O runs under the path guards is
                    # refused where it writes, because only the write
                    # knows whether a line writes: `gzip -c`, `tar -t` and
                    # `split -n 1/2` read a read-only mount like any
                    # reader, and `gzip f` is refused at the write of
                    # `f.gz`, in gzip's own GNU voice. A write command
                    # that reaches its service some other way (trello's
                    # id-addressed card writes, a custom backend's own
                    # verb) is refused here, before it runs, because no
                    # door would see its write. strongest_mode_under, not
                    # effective_mode: a mount whose only writable region
                    # is a show entry still runs it. The trailing newline
                    # is load-bearing: stderr accumulates across a line.
                    if (
                        cmd.write
                        and not cmd.path_guarded
                        and not info_only
                        and strongest_mode_under(
                            self.prefix, self.mode, bound_io
                        )
                        == MountMode.READ
                    ):
                        return None, IOResult(
                            exit_code=1,
                            stderr=encode_text(
                                f"{cmd_name}: read-only mount "
                                f"at {self.prefix}\n"
                            ),
                        )
                    # The dispatch-level guard only sees default limits
                    # (the mount is unknown before routing), so the
                    # mount-resolved timeout must also bound the command
                    # body: eager commands do their work inside cmd.fn,
                    # where the stream-consumption guard never runs.
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
                        result = await run_with_timeout(
                            cmd.fn(self.vfs.accessor, paths, texts, opts),
                            cmd_timeout,
                            cmd_name,
                        )
                    if result is not None:
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
                        if stream is not None and not isinstance(
                            stream, bytes
                        ):
                            stream = _command_output(
                                stream, io, cmd_name, paths
                            )
                        return stream, io
                return None, IOResult()
            finally:
                reset_revisions(revs_token)
                reset_active_recorder(recording_token)
                push_cache_manager(prev_manager)

    def supports_op(self, op_name: str, path: str) -> bool:
        """Report whether an op would resolve for a path on this mount.

        Args:
            op_name (str): operation name (e.g. "setattr").
            path (str): virtual path (drives filetype-specific lookup).
        """
        filetype = get_extension(path)
        return bool(self._resolve_cascade(op_name, filetype, self._ops))

    async def execute_op(
        self,
        op_name: str,
        path: str,
        *args,
        **kwargs,
    ) -> Any:
        """Execute a VFS op on this mount's VFS.

        Tries filetype-specific first, then VFS-specific.
        First non-None result wins.

        A caller may override the filetype by passing one, and passing
        None asks for the by-VFS op even where a filetype-scoped
        one is registered. That is what a read-modify-write needs: it
        hands whatever it read straight back to ``write``, which always
        stores, so reading a rendered form would store the rendering
        over the file. TypeScript spells the same override
        ``readFile(path, {raw: true})``.

        Args:
            op_name (str): operation name (e.g. "read", "stat").
            path (str): virtual path.
        """
        async with self.use():
            filetype = (
                kwargs.pop("filetype")
                if "filetype" in kwargs
                else get_extension(path)
            )
            levels = self._resolve_cascade(op_name, filetype, self._ops)
            if not levels:
                raise enotsup(str(self.vfs.name), op_name, path)

            if any(o.write for o in levels):
                dst = kwargs.get("dst")
                endpoints = [PathSpec.from_str_path(path)]
                if isinstance(dst, PathSpec):
                    endpoints.append(dst)
                require_paths_writable(
                    endpoints,
                    self.prefix,
                    self.mode,
                    subtree=op_name in _SUBTREE_OPS,
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
            op_override = self.command_limits.get(op_name)
            op_timeout = (
                op_override.timeout_seconds
                if op_override is not None
                else None
            )
            recording_token = push_mount_context(self.mount_id)
            revs_token = push_revisions(self.revisions or None)
            try:
                for op in levels:
                    # The backend's own paths are host paths, so the process
                    # patch (runtime/python/host/fs.py and open.py) must not answer
                    # them: a disk mount rooted at its own virtual prefix
                    # spells the two the same, and routing the physical one
                    # hands the op back to the backend serving it.
                    with host_io():
                        result = op.fn(
                            self.vfs.accessor, scope, *args, **kwargs
                        )
                        if inspect.isawaitable(result):
                            result = await run_with_timeout(
                                result, op_timeout, op_name
                            )
                    if result is not None:
                        return _wrap_op_stream(
                            result, self.mount_id, self.activity
                        )
                return None
            finally:
                reset_revisions(revs_token)
                reset_active_recorder(recording_token)
