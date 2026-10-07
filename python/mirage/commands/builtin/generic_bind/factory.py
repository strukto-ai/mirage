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
from collections.abc import Callable
from dataclasses import replace
from typing import Any

from mirage.accessor.base import Accessor
from mirage.cache.context import active_cache_manager
from mirage.cache.read_through import (
    cache_aware_read_bytes,
    cache_aware_read_stream,
)
from mirage.commands.builtin.generic_bind.adapter import (
    CommandIO,
    scoped_io,
    with_command_guards,
    with_dir_guard,
    with_policy_guard,
    with_recording,
)
from mirage.commands.builtin.generic_bind.builders import BUILDERS
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.context.types import IOContext
from mirage.errors.fs import eisdir
from mirage.ops.types import NamespaceView
from mirage.types import PathSpec


def _cached_stat(
    stat: Callable[..., Any],
    accessor: Accessor,
    path: PathSpec,
    *args,
    **kwargs,
):
    manager = active_cache_manager()
    return _cached_stat_result(manager, stat, accessor, path, *args, **kwargs)


async def _cached_stat_result(
    manager,
    stat: Callable[..., Any],
    accessor: Accessor,
    path: PathSpec,
    *args,
    **kwargs,
):
    result = await stat(accessor, path, *args, **kwargs)
    if (
        result is not None
        and getattr(result, "size", None) is None
        and manager is not None
    ):
        # cached_size, not cached_bytes: this runs only where the backend
        # named no size -- the API mounts -- so gating it would turn a
        # stat into a backend stat.
        size = await manager.cached_size(path)
        if size is not None:
            result = result.model_copy(update={"size": size})
    return result


def with_read_cache(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose byte reads serve cached bytes when warm.

    The factory hands this to every ``read=True`` command so a warm read
    is served from the file cache without the command knowing about it,
    mirroring how readdir/stat already serve the index cache inside the
    op. Content (read_stream/read_bytes) and the size a render-dependent
    backend can't know on its own (stat, filled from the cached byte
    length) are both served, so a warm read-only command stays on its
    real mount and needs no redirect to the cache mount. The manager is
    captured eagerly (when the ops method is called, inside the command's
    cache-manager scope) rather than read lazily at stream-drain time,
    when that scope is already gone. ``CacheManager.cached_bytes`` is a
    no-op (returns None) for local or non-caching mounts, so this is safe
    to apply uniformly.

    Args:
        ops (CommandIO): the backend's IO adapter.
    """
    read_bytes = cache_aware_read_bytes(ops.read_bytes)
    return replace(
        with_stat_cache(ops),
        read_stream=(
            functools.partial(stream_from_bytes, read_bytes)
            if ops.streams_bytes
            else cache_aware_read_stream(ops.read_stream)
        ),
        read_bytes=read_bytes,
    )


def scan_io(
    ops: CommandIO,
    ns: NamespaceView | None,
    prefix: str,
    context: IOContext | None = None,
) -> tuple[CommandIO, bool]:
    """The adapter a bespoke search command scans through, and whether a
    hide, a path rule or a coded pre_vfs policy judges anything on its
    mount.

    The mount, not the operands: a service's own search answers for more
    than the operand it is given (a whole folder for one of its days,
    every channel under a container). A judged command must not hand the
    service's search the answer, since the service sees every entry, and
    its scan reads the operands through the guards the generic builders
    bind, over the read cache as theirs is, so a warm copy is served only
    once the path is admitted; an unjudged one scans the raw adapter.

    Args:
        ops (CommandIO): the backend's raw IO adapter.
        ns (NamespaceView | None): the command's namespace view.
        prefix (str): the prefix of the mount running the command.
    """
    if context is not None:
        ops = with_recording(replace(ops, io_context=context))
    scoped = ns.scoped if ns is not None else None
    if scoped is None or not scoped(prefix.rstrip("/") or "/"):
        return ops, False
    return with_command_guards(with_policy_guard(with_read_cache(ops))), True


async def _slash_checked_write(
    write: Callable[..., Any],
    accessor: Accessor,
    path: PathSpec,
    *args,
    **kwargs,
):
    # open(2) with O_CREAT refuses a slash-terminated name outright,
    # before looking anything up: `x/` can only ever be a directory, so
    # there is nothing to create and nothing to truncate. GNU tee and
    # truncate both answer `missing/` with "Is a directory" and touch
    # nothing, and a plain file behind the slash gets the same answer.
    # Deliberate divergence: under a parent that is itself absent GNU
    # reports the parent first (ENOENT); the spelling is refused here
    # without a round trip, so that corner reads EISDIR too.
    if path.raw_path.endswith("/"):
        raise eisdir(path)
    return await write(accessor, path, *args, **kwargs)


def with_slash_guard(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose writes refuse a slash-terminated operand.

    open(2) with O_CREAT answers ``x/`` with EISDIR whether or not
    anything is there, so ``write``, ``append``, ``pwrite`` and
    ``truncate`` refuse it before the backend sees it and ``tee missing/``
    cannot leave a regular file named ``missing`` behind. The read side is
    the walk guard's: a slashed operand carries a ``dotted`` spelling, so
    ``dot_refusal`` proves the name a directory there (``cat reg/`` is
    "Not a directory", ``cat dangle/`` keeps its own ENOENT).

    Args:
        ops (CommandIO): the backend's IO adapter.
    """
    changes: dict[str, Any] = {
        slot: functools.partial(_slash_checked_write, getattr(ops, slot))
        for slot in ("write", "append", "pwrite", "truncate")
        if getattr(ops, slot) is not None
    }
    return replace(ops, **changes)


def with_stat_cache(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose ``stat`` fills size from the cache when warm.

    Metadata commands (ls, stat, du) don't read content, but for a
    render-dependent backend the only place a cached file's size exists
    is the file cache (the rendered bytes). This fills that size in on
    the real mount, so a warm ``stat``/``ls -l`` reports it without a
    redirect to the cache mount. No-op when the backend already knows the
    size or the path isn't cached.

    Args:
        ops (CommandIO): the backend's IO adapter.
    """
    return replace(ops, stat=functools.partial(_cached_stat, ops.stat))


async def _probe_answered_stat(
    stat: Callable[..., Any],
    accessor: Accessor,
    path: PathSpec,
    *args,
    **kwargs,
):
    # The freshness probe already asked the backend this command; asking
    # again resolves through listings fresh has not re-checked yet.
    manager = active_cache_manager()
    probed = None if manager is None else manager.probed_stat(path)
    if probed is not None:
        return probed
    return await stat(accessor, path, *args, **kwargs)


def with_probe_answers(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose ``stat`` serves this command's probe answer.

    Under fresh the freshness probe has already asked the backend about
    the operand (``CacheManager.probed_stat``). It is the backend's own
    op-table stat, so this goes only on an adapter whose ``stat`` is that
    function: a per-command stat (dify's light ``ls``) keeps asking, so
    what it prints never changes with the policy.

    Applied to the raw adapter, below the path guards: a hidden or
    refused path is answered by its guard before any remembered answer,
    and every other slot keeps the guard order it always had.

    Args:
        ops (CommandIO): the backend's raw IO adapter.
    """
    return replace(ops, stat=functools.partial(_probe_answered_stat, ops.stat))


def _read_wraps(ops: CommandIO) -> CommandIO:
    return with_slash_guard(with_read_cache(ops))


def _stat_wraps(ops: CommandIO) -> CommandIO:
    return with_slash_guard(with_stat_cache(ops))


def _write_wraps(ops: CommandIO) -> CommandIO:
    return with_slash_guard(ops)


async def _run_with_namespace_globs(
    ops: CommandIO,
    finish: Callable[[CommandIO], CommandIO],
    fn: Callable[..., Any],
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> Any:
    """Run a builder with an adapter that carries the invocation's
    namespace facts below every guard.

    A nested mount's keys live in another VFS and no VFS stores
    a symlink, so a glob resolved by one backend's readdir misses both,
    while the same names are already merged into a listing. The adapter
    is built once per backend and the names are session-scoped, so the
    fact is stamped on here, per invocation, from ``opts.ns`` -- and the
    whole guard chain is applied on top of the stamped copy, so every
    guard that consumes a namespace fact simply reads it off the
    adapter it wraps: glob resolution derives from ``glob_children``,
    the dir guard closes over it, and the hidden guard's rmdir captures
    it for its emptiness judgment. Binding the guards at registration
    instead would strand them behind partials built before any
    invocation exists, which is exactly the wiring that made the rmdir
    guard blind to a mounted child. The stamp happens whether or not
    the namespace owes this directory anything, so there is one code
    path rather than two; the guards read the current session at call
    time, so per-invocation binding changes cost, not behavior.

    ``ops`` stays the first bound argument, because that partial slot is
    how the adapter is reached for a registered command; it arrives raw
    and is guarded here.

    Args:
        ops (CommandIO): the backend's raw IO adapter.
        finish (Callable): the builder tier's cache and slash wraps,
            chosen at registration from the builder's read/write kind.
        fn (Callable): the builder's command function.
        accessor (Accessor): backend handle.
        paths (list[PathSpec]): the command's path operands.
        texts (list[str]): the command's text arguments.
        opts (CommandOpts): the per-invocation option bag.
    """
    children = opts.ns.child_mounts if opts.ns is not None else None
    links = opts.ns.links if opts.ns is not None else None
    stamped = replace(
        ops,
        io_context=opts.io_context,
        glob_children=children,
        glob_target_stat=(links.target_stat if links is not None else None),
    )
    # Command path restrictions speak first, then the coded pre_vfs
    # hooks, both outside the cache wraps (`finish`) so a refusal fires
    # before a warm serve, the dispatcher's own order at the op door. A
    # probe answer is served below them (`with_probe_answers` on the
    # raw adapter), so they still judge every path before it. Under a
    # hide or a path rule the native subtree ops are set aside
    # (`scoped_io`), so every entry passes through the guarded walk.
    bound = with_dir_guard(
        with_command_guards(with_policy_guard(finish(with_recording(stamped))))
    )
    bound = scoped_io(bound, opts.ns, paths or [opts.cwd], opts.mount_prefix)
    return await fn(bound, accessor, paths, texts, opts)


def make_generic_commands(
    vfs: str,
    ops: CommandIO,
    *,
    overrides: set[str] | None = None,
    ops_overrides: dict[str, CommandIO] | None = None,
) -> list[Callable[..., Any]]:
    """Generate the default command set for a backend from its ops.

    Args:
        vfs (str): VFS name the commands register under.
        ops (CommandIO): the backend's IO adapter.
        overrides (set[str] | None): command names to skip (the backend
            ships its own wrapper for these).
        ops_overrides (dict[str, CommandIO] | None): per-command adapters
            that replace the shared adapter when one command needs a cheaper
            backend operation.
    """
    skip = overrides or set()
    ops_over = ops_overrides or {}
    # A name no builder has does nothing at all, so a misspelled override
    # left the generic registered beside the bespoke one, and an override
    # for a command the table never had (mem0's `search`) read as if it
    # displaced something. Refused at registration, which is import time.
    known = {b.name for b in BUILDERS}
    unknown = sorted((set(skip) | set(ops_over)) - known)
    if unknown:
        raise ValueError(
            f"make_generic_commands({vfs!r}): no generic "
            f"builder named {', '.join(unknown)}"
        )
    commands: list[Callable[..., Any]] = []
    for b in BUILDERS:
        if b.name in skip:
            continue
        raw = ops_over.get(b.name, ops)
        finish: Callable[[CommandIO], CommandIO]
        if b.read:
            finish = _read_wraps
        elif not b.write:
            finish = _stat_wraps
        else:
            finish = _write_wraps
        # A per-command adapter with its own stat (dify's light ls) would
        # otherwise print the probe's full stat under fresh only.
        answered = (
            with_probe_answers(raw)
            if raw.stat is ops.stat and not b.write
            else raw
        )
        bound = functools.partial(
            _run_with_namespace_globs, answered, finish, b.fn
        )
        agg = b.aggregate if raw.local else None
        commands.append(
            command(
                b.name,
                vfs=vfs,
                spec=SPECS[b.name],
                aggregate=agg,
                write=b.write,
                path_guarded=True,
            )(bound)
        )
    return commands


def invocation_io(ops: CommandIO, opts: CommandOpts) -> CommandIO:
    """Apply caller-owned guards to a bespoke backend command's adapter."""
    links = opts.ns.links if opts.ns is not None else None
    stamped = replace(
        ops,
        io_context=opts.io_context,
        glob_children=opts.ns.child_mounts if opts.ns is not None else None,
        glob_target_stat=links.target_stat if links is not None else None,
    )
    return with_command_guards(
        with_policy_guard(with_recording(with_slash_guard(stamped)))
    )
