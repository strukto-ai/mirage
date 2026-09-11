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
import errno
import inspect
from collections.abc import AsyncIterator, Awaitable, Iterable
from contextlib import asynccontextmanager
from typing import Any, Callable

from mirage.cache.context import push_cache_manager
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.commands.config import CommandOpts, ExecContext, RegisteredCommand
from mirage.commands.resolve import get_extension
from mirage.commands.spec import CommandSpec
from mirage.commands.spec.types import FlagValue
from mirage.context import (effective_mount_mode, effective_path_mode,
                            readonly_below, reset_mount_gate, set_mount_gate,
                            strongest_mode_under)
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.types import ByteSource, IOResult
from mirage.observe.context import (push_mount_context, push_revisions,
                                    reset_active_recorder, reset_revisions,
                                    with_mount_prefix, with_revisions)
from mirage.ops.host_io import host_io, with_host_io
from mirage.ops.registry import RegisteredOp
from mirage.policy import resolve_limit
from mirage.resource.base import BaseResource
from mirage.types import (ConsistencyPolicy, FileType, Limit, MountMode,
                          PathSpec, Producer)
from mirage.utils.errors import ReadOnlyError, ebusy, enotsup
from mirage.utils.ids import uuid7
from mirage.utils.key_prefix import mount_key
from mirage.workspace.mount.activity import ResourceActivity

# Ops that mutate everything under their endpoints in one backend call
# (a directory rename relocates its whole subtree), so the door also
# refuses a read-only region below either endpoint. The removal ops
# stay per-path: the runtimes compose rmtree from unlink/rmdir, and
# each of those answers for its own path above.
_SUBTREE_OPS = frozenset({"rename"})


def _wrap_cmd_streams(
    result: tuple[ByteSource | None, IOResult],
    mount_prefix: str,
    revisions: dict[str, str] | None,
    mount_id: str | None = None,
    activity: ResourceActivity | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Wrap any async-iterator streams in ``result`` with the mount
    prefix and active revisions, so ``record_stream`` and
    ``revision_for`` calls inside the lazy backend body see the right
    context when consumed after this frame exits.

    Mirrors the ``exit_on_empty`` pattern: thin async-gen wrapper that
    side-effects the recorder state as bytes flow through. Same object
    appearing in both the primary stream and IOResult.reads/writes is
    wrapped once (dedup by identity).

    Args:
        result: ``(stream, io)`` as returned by a command handler.
        mount_prefix: prefix to push during stream consumption.
        revisions: revisions map to push during stream consumption
            (None when the mount has no pins installed).
        mount_id (str | None): identity of the serving mount.
    """
    stream, io = result
    seen: dict[int, ByteSource] = {}

    def _wrap(obj: ByteSource) -> ByteSource:
        if isinstance(obj, (bytes, bytearray)):
            return obj
        oid = id(obj)
        if oid in seen:
            return seen[oid]
        source = obj.source if isinstance(obj, CachableAsyncIterator) else obj
        wrapped = with_mount_prefix(mount_prefix, source, mount_id)
        if revisions:
            wrapped = with_revisions(revisions, wrapped)
        wrapped = with_host_io(wrapped)
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


def _wrap_op_stream(result: Any, mount_prefix: str, mount_id: str,
                    activity: ResourceActivity) -> Any:
    """Hold the host-I/O bypass around an op result that streams.

    An op that returns an async iterator has not run its body yet: the
    backend opens the file on the first ``__anext__``, after the frame
    that called it (and its ``host_io`` scope) is gone. Same reason
    ``_wrap_cmd_streams`` re-establishes the recorder state.

    Args:
        result (Any): whatever the op returned.
        mount_prefix (str): virtual mount prefix.
        mount_id (str): identity of the serving mount.
    """
    if isinstance(result, CachableAsyncIterator):
        result.replace_source(
            with_host_io(
                with_mount_prefix(mount_prefix, result.source, mount_id)))
        return activity.hold(result)
    if hasattr(result, "__aiter__"):
        return activity.hold(
            with_host_io(with_mount_prefix(mount_prefix, result, mount_id)))
    return result


class MountEntry:
    """A mounted resource with command and op dispatch.

    Each mount has its own lookup tables for commands and ops.
    Different mounts of the same resource type can have
    different registered commands/ops.

    Resolution hierarchy (same for commands and ops):
    1. (name, extension) -- filetype-specific
    2. (name, None) -- resource-specific
    3. general[name] -- general fallback
    """

    def __init__(
        self,
        prefix: str,
        resource: BaseResource,
        mode: MountMode = MountMode.READ,
        consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
    ) -> None:
        if not prefix.startswith("/"):
            raise ValueError(f"prefix must start with /: {prefix!r}")
        if not prefix.endswith("/"):
            raise ValueError(f"prefix must end with /: {prefix!r}")
        if "//" in prefix:
            raise ValueError(f"prefix must not contain //: {prefix!r}")
        self.mount_id = uuid7()
        self.prefix = prefix
        self.resource = resource
        self.mode = mode
        self.consistency = consistency
        self.activity = ResourceActivity()
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
        self._general_ops: dict[str, RegisteredOp] = {}
        # key: (cmd_name, target_resource_type)
        self._cross_cmds: dict[tuple[Any, ...], RegisteredCommand] = {}

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

    async def expand_glob(self, paths: list[PathSpec],
                          prefix: str) -> list[PathSpec]:
        """Keep the resource open and prepared while its glob hook runs."""
        async with self.use():
            if self.cache_manager is None:
                return await self.resource.resolve_glob(paths, prefix=prefix)
            async with self.cache_manager.mutation():
                await self.ensure_ready()
                return await self.resource.resolve_glob(paths, prefix=prefix)

    @property
    def index(self) -> IndexCacheStore:
        index = self.resource.index
        return self.cache_manager.scope_index(
            index) if self.cache_manager else index

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

    def register(self, cmd: RegisteredCommand) -> None:
        """Register a resource-specific command."""
        key = (cmd.name, cmd.filetype)
        self._cmds[key] = cmd
        if cmd.spec is not None:
            self._cmd_specs[cmd.name] = cmd.spec
        self._prefix_index = None

    def register_general(
        self,
        cmd: RegisteredCommand,
    ) -> None:
        """Register a general command (resource=None).

        General commands work on any resource (e.g. echo, pwd).
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
        2. (cmd_name, None) -- resource-specific
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
            names = (set(self._cmd_specs) | {n
                                             for n, _ in self._cmds}
                     | set(self._general_cmds))
            for name in names:
                tokens = name.split(" ")
                if len(tokens) > 1:
                    index.setdefault(tokens[0], set()).add(len(tokens))
            self._prefix_index = {
                k: sorted(v, reverse=True)
                for k, v in index.items()
            }
        for length in self._prefix_index.get(words[0], ()):
            if length <= len(words) and self.resolve_command(" ".join(
                    words[:length])) is not None:
                return length
        return 1

    def spec_for(
        self,
        cmd_name: str,
    ) -> CommandSpec | None:
        """Get the spec for a command name."""
        return self._cmd_specs.get(cmd_name)

    def is_general_command(self, cmd_name: str) -> bool:
        """Whether `cmd_name` is registered as a general command here."""
        return cmd_name in self._general_cmds

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
            ValueError: If a command/op's resource doesn't match
                this mount's resource.
        """
        pname = self.resource.name
        for fn in fns:
            rcs: list[RegisteredCommand] = ([fn] if isinstance(
                fn, RegisteredCommand) else getattr(fn, "_registered_commands",
                                                    []))
            if rcs:
                matching = [
                    rc for rc in rcs
                    if rc.resource is None or rc.resource == pname
                ]
                if rcs and not matching:
                    resources = sorted(
                        {rc.resource
                         for rc in rcs if rc.resource is not None})
                    raise ValueError(
                        f"command {rcs[0].name!r} is for resource(s) "
                        f"{resources!r}, not {pname!r}")
                for rc in matching:
                    self.register(rc)
            ros: list[RegisteredOp] = ([fn] if isinstance(fn, RegisteredOp)
                                       else getattr(fn, "_registered_ops", []))
            if ros:
                matching_ops = [
                    ro for ro in ros
                    if ro.resource is None or ro.resource == pname
                ]
                if ros and not matching_ops:
                    resources = sorted(
                        {ro.resource
                         for ro in ros if ro.resource is not None})
                    raise ValueError(f"op {ros[0].name!r} is for resource(s) "
                                     f"{resources!r}, not {pname!r}")
                for ro in matching_ops:
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
            self._general_ops.pop(name, None)

    def commands(self) -> dict[str, list[str | None]]:
        """List registered commands grouped by filetype variants.

        Returns:
            dict[str, list[str | None]]: Command name to filetype list.
        """
        result: dict[str, list[str | None]] = {}
        for (name, filetype) in self._cmds:
            result.setdefault(name, []).append(filetype)
        for name in self._general_cmds:
            result.setdefault(name, [])
        for name in result:
            result[name] = sorted(result[name],
                                  key=lambda x: (x is not None, x or ""))
        return dict(sorted(result.items()))

    def registered_ops(self) -> dict[str, list[str | None]]:
        """List registered ops grouped by filetype variants.

        Returns:
            dict[str, list[str | None]]: Op name to filetype list.
        """
        result: dict[str, list[str | None]] = {}
        for (name, filetype) in self._ops:
            result.setdefault(name, []).append(filetype)
        for name in self._general_ops:
            result.setdefault(name, [])
        for name in result:
            result[name] = sorted(result[name],
                                  key=lambda x: (x is not None, x or ""))
        return dict(sorted(result.items()))

    # ── cross-mount registration ─────────────────────

    def register_cross(
        self,
        cmd: RegisteredCommand,
        target_resource_type: str,
    ) -> None:
        """Register a cross-mount command for a target.

        Example::

            mount.register_cross(cp_cmd, "ram")
            # This mount can now cp to ram mounts

        Args:
            cmd: the cross-mount command.
            target_resource_type: e.g. "ram", "s3".
        """
        key = (cmd.name, target_resource_type)
        self._cross_cmds[key] = cmd

    def resolve_cross(
        self,
        cmd_name: str,
        target_resource_type: str,
    ) -> RegisteredCommand | None:
        """Find a cross-mount command for a target."""
        return self._cross_cmds.get((cmd_name, target_resource_type))

    # ── op registration ───────────────────────────────

    def register_op(self, op: RegisteredOp) -> None:
        """Register a resource-specific VFS op."""
        key = (op.name, op.filetype)
        self._ops[key] = op

    def _resolve_cascade(
        self,
        name: str,
        extension: str | None,
        table: dict[tuple[Any, ...], Any],
        general: dict[str, Any],
    ) -> list[Any]:
        """Resolve with cascade: try filetype, resource, general.

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
        entry = general.get(name)
        if entry is not None:
            levels.append(entry)
        return levels

    # ── execution ─────────────────────────────────────

    async def execute_cmd(
        self,
        cmd_name: str,
        paths: list[PathSpec],
        texts: list[str],
        flag_kwargs: dict[str, FlagValue],
        context: ExecContext = ExecContext(),
    ) -> tuple[ByteSource | None, IOResult]:
        """Execute a command on this mount's resource.

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
            if (extension is not None and paths and stat_path is not None
                    and (cmd_name, extension) in self._cmds):
                entry = await stat_path(paths[0].virtual)
                if entry is not None and entry.type == FileType.DIRECTORY:
                    extension = None

            handlers = self._resolve_cascade(cmd_name, extension, self._cmds,
                                             self._general_cmds)
            if not handlers:
                return None, IOResult(
                    exit_code=127,
                    stderr=(f"{cmd_name}: command not found".encode()))

            mount_prefix = self.prefix.rstrip("/")
            filetype_fns = self.filetype_handlers(cmd_name)
            is_filetype_cmd = extension is not None and (
                cmd_name, extension) in self._cmds

            paths = [
                dataclasses.replace(
                    p, resource_path=mount_key(p.virtual, mount_prefix))
                if isinstance(p, PathSpec) else p for p in paths
            ]

            # Stamp this mount's backend key onto path-shaped flag values so
            # backend reads can address them: a single PathSpec (e.g. awk -f,
            # single grep -f) or a list of PathSpec (multiple grep -f).
            # Everything else (bools, strings, list[str] like repeated -e) is
            # not a path and passes through unchanged.
            flags: dict[str, FlagValue] = {}
            for k, v in flag_kwargs.items():
                if isinstance(v, PathSpec):
                    flags[k] = dataclasses.replace(v,
                                                   resource_path=mount_key(
                                                       v.virtual,
                                                       mount_prefix))
                elif isinstance(v, list) and v and all(
                        isinstance(item, PathSpec) for item in v):
                    specs = [item for item in v if isinstance(item, PathSpec)]
                    flags[k] = [
                        dataclasses.replace(item,
                                            resource_path=mount_key(
                                                item.virtual, mount_prefix))
                        for item in specs
                    ]
                else:
                    flags[k] = v
            # One typed bag, constructed here and nowhere else; a handler
            # reads the fields it wants and ignores the rest, so there is no
            # opt-in registry (mirrors Mount.executeCmd building CommandOpts).
            opts = CommandOpts(
                stdin=stdin,
                flags=flags,
                cwd=PathSpec(
                    virtual=cwd,
                    directory=cwd,
                    resolved=False,
                    resource_path=mount_key(cwd, mount_prefix),
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
            )

            recording_token = push_mount_context(mount_prefix, self.mount_id)
            revs_token = push_revisions(self.revisions or None)
            prev_manager = push_cache_manager(self.cache_manager)
            # What the command tier's mode guard reads: the write-command
            # gate below admits a command when any shown subtree grants
            # writes, and this binding is how each write the handler then
            # makes is held to its own region's mode.
            gate_token = set_mount_gate(self.prefix, self.mode)
            try:
                # --help / --version short-circuit inside the handler wrapper
                # and never touch the backend, so a read-only mount answers
                # them like GNU instead of refusing them as writes.
                info_only = (flags.get("help") is True
                             or flags.get("version") is True)
                for cmd in handlers:
                    # strongest_mode_under, not effective_mode: a mount
                    # whose only writable region is a show entry still runs
                    # the command, and the op door refuses per path. The
                    # trailing newline is load-bearing: stderr accumulates
                    # across a line, so two refusals in one list ran
                    # together as `...at /ro/rm: read-only mount at /ro/`,
                    # and the node table's twin of this refusal (a symlink
                    # `rm`, rendered by shared.read_only_error) concatenates
                    # with it.
                    if (cmd.write and not info_only and strongest_mode_under(
                            self.prefix, self.mode) == MountMode.READ):
                        return None, IOResult(
                            exit_code=1,
                            stderr=(f"{cmd_name}: read-only mount "
                                    f"at {self.prefix}\n".encode()))
                    # The dispatch-level guard only sees default limits
                    # (the mount is unknown before routing), so the
                    # mount-resolved timeout must also bound the command
                    # body: eager commands do their work inside cmd.fn,
                    # where the stream-consumption guard never runs.
                    resolved_limit = resolve_limit(
                        cmd_name,
                        command_default=cmd.limit,
                        mount_override=self.command_limits.get(cmd_name))
                    cmd_timeout = (resolved_limit.timeout_seconds
                                   if resolved_limit is not None else None)
                    with host_io():
                        result = await run_with_timeout(
                            cmd.fn(self.resource.accessor, paths, texts, opts),
                            cmd_timeout, cmd_name)
                    if result is not None:
                        stream, io = _wrap_cmd_streams(result, mount_prefix,
                                                       self.revisions or None,
                                                       self.mount_id,
                                                       self.activity)
                        io.producer = Producer(command=cmd_name,
                                               prefixes=(self.prefix, ),
                                               declared=cmd.limit)
                        return stream, io
                return None, IOResult()
            finally:
                reset_mount_gate(gate_token)
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
        return bool(
            self._resolve_cascade(op_name, filetype, self._ops,
                                  self._general_ops))

    async def execute_op(
        self,
        op_name: str,
        path: str,
        *args,
        **kwargs,
    ) -> Any:
        """Execute a VFS op on this mount's resource.

        Tries filetype-specific first, then resource-specific.
        First non-None result wins.

        A caller may override the filetype by passing one, and passing
        None asks for the by-resource op even where a filetype-scoped
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
            filetype = (kwargs.pop("filetype")
                        if "filetype" in kwargs else get_extension(path))
            levels = self._resolve_cascade(op_name, filetype, self._ops,
                                           self._general_ops)
            if not levels:
                raise enotsup(str(self.resource.name), op_name, path)

            if any(o.write for o in levels):
                # GNU reports the operand, not the guard's own wording, so
                # stamp errno + filename and let format_fs_error render
                # "<cmd>: <path>: Read-only file system" (mirrors the
                # TypeScript erofsReadOnly stamp). Per path, not per mount:
                # a show entry can hold one subtree below `w` on a writable
                # mount, or one writable region on a read mount. A rename
                # mutates its destination too, so both endpoints answer,
                # and it relocates whole subtrees in one call, so a
                # read-only region below either endpoint refuses it too.
                if effective_path_mode(path, self.prefix,
                                       self.mode) == MountMode.READ:
                    raise ReadOnlyError(errno.EROFS, "Read-only file system",
                                        path)
                dst = kwargs.get("dst")
                if isinstance(dst, PathSpec) and effective_path_mode(
                        dst.virtual, self.prefix, self.mode) == MountMode.READ:
                    raise ReadOnlyError(errno.EROFS, "Read-only file system",
                                        dst.virtual)
                if op_name in _SUBTREE_OPS:
                    endpoints = [path]
                    if isinstance(dst, PathSpec):
                        endpoints.append(dst.virtual)
                    for endpoint in endpoints:
                        blame = readonly_below(endpoint, self.prefix,
                                               self.mode)
                        if blame is not None:
                            raise ReadOnlyError(errno.EROFS,
                                                "Read-only file system", blame)

            mount_prefix = self.prefix.rstrip("/")
            scope = PathSpec(
                virtual=path,
                directory=path.rsplit("/", 1)[0] or "/",
                resource_path=mount_key(path, mount_prefix),
            )
            kwargs.setdefault("index", self.index)
            # Per-op caps are policy and fire at the op doors (post_ops);
            # only the timeout stays here, bounding the backend call itself.
            op_override = self.command_limits.get(op_name)
            op_timeout = (op_override.timeout_seconds
                          if op_override is not None else None)
            recording_token = push_mount_context(mount_prefix, self.mount_id)
            revs_token = push_revisions(self.revisions or None)
            try:
                for op in levels:
                    # The backend's own paths are host paths, so the process
                    # patch (ops/os_patch.py, ops/open.py) must not answer
                    # them: a disk mount rooted at its own virtual prefix
                    # spells the two the same, and routing the physical one
                    # hands the op back to the backend serving it.
                    with host_io():
                        result = op.fn(self.resource.accessor, scope, *args,
                                       **kwargs)
                        if inspect.isawaitable(result):
                            result = await run_with_timeout(
                                result, op_timeout, op_name)
                    if result is not None:
                        return _wrap_op_stream(result, mount_prefix,
                                               self.mount_id, self.activity)
                return None
            finally:
                reset_revisions(revs_token)
                reset_active_recorder(recording_token)
