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
from mirage.commands.builtin.generic_bind.adapter import (
    mount_io,
    scoped_io,
    with_command_guards,
    with_dir_guard,
    with_policy_guard,
)
from mirage.commands.builtin.generic_bind.builders import BUILDERS
from mirage.commands.config import CommandIO, CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.errors.fs import eisdir
from mirage.types import PathSpec
from mirage.view.types import NamespaceView


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


def scan_io(
    ops: CommandIO,
    ns: NamespaceView | None,
    prefix: str,
) -> tuple[CommandIO, bool]:
    """The adapter a bespoke search command scans through, and whether a
    hide, a path rule or a coded pre_vfs policy judges anything on its
    mount.

    The mount, not the operands: a service's own search answers for more
    than the operand it is given (a whole folder for one of its days,
    every channel under a container). A judged command must not hand the
    service's search the answer, since the service sees every entry, and
    its scan reads the operands through the guards the generic builders
    bind; an unjudged one scans the mount's own table. Either reads its
    content at the door, which admits the path before a warm serve.

    Args:
        ops (CommandIO): the backend's raw IO adapter.
        ns (NamespaceView | None): the command's namespace view.
        prefix (str): the prefix of the mount running the command.
    """
    scoped = ns.scoped if ns is not None else None
    if scoped is None or not scoped(prefix.rstrip("/") or "/"):
        return ops, False
    return with_command_guards(with_policy_guard(with_stat_cache(ops))), True


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


def _stat_wraps(ops: CommandIO) -> CommandIO:
    return with_slash_guard(with_stat_cache(ops))


def _write_wraps(ops: CommandIO) -> CommandIO:
    return with_slash_guard(ops)


async def _run_with_namespace_globs(
    finish: Callable[[CommandIO], CommandIO],
    fn: Callable[..., Any],
    table: Callable[[CommandIO], CommandIO] | None,
    adapt: Callable[[CommandIO], CommandIO] | None,
    write: bool,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> Any:
    """Run a builder over the mount's table, with the invocation's
    namespace facts stamped on below every guard.

    The table is the mount's (``opts.io``), read per invocation, so one
    registration serves every mount of the backend. A nested mount's
    keys live in another VFS and no VFS stores a symlink, so a glob
    resolved by one backend's readdir misses both, while the same names
    are already merged into a listing. The names are session-scoped, so
    the fact is stamped on here, per invocation, from ``opts.ns`` -- and
    the whole guard chain is applied on top of the stamped copy, so every
    guard that consumes a namespace fact simply reads it off the table it
    wraps: glob resolution derives from ``glob_children``, the dir guard
    closes over it, and the hidden guard's rmdir captures it for its
    emptiness judgment. The stamp happens whether or not the namespace
    owes this directory anything, so there is one code path rather than
    two; the guards read the current session at call time.

    A read-only builder's stat serves the freshness probe's answer
    (``with_probe_answers``), unless the command swaps in a stat of its
    own (dify's light ``ls``), so what that prints never changes with
    the policy.

    Args:
        finish (Callable): the builder tier's stat and slash wraps,
            chosen at registration from the builder's read/write kind.
        fn (Callable): the builder's command function.
        table (Callable | None): the backend's change to the table for
            every command.
        adapt (Callable | None): the command's own change to the table.
        write (bool): whether the builder writes.
        accessor (Accessor): backend handle.
        paths (list[PathSpec]): the command's path operands.
        texts (list[str]): the command's text arguments.
        opts (CommandOpts): the per-invocation option bag.
    """
    io = table(mount_io(opts)) if table is not None else mount_io(opts)
    raw = adapt(io) if adapt is not None else io
    if raw.stat is io.stat and not write:
        raw = with_probe_answers(raw)
    children = opts.ns.child_mounts if opts.ns is not None else None
    links = opts.ns.links if opts.ns is not None else None
    stamped = replace(
        raw,
        glob_children=children,
        glob_target_stat=(links.target_stat if links is not None else None),
    )
    # Command path restrictions speak first, then the coded pre_vfs
    # hooks, both outside the stat and slash wraps (`finish`). Content
    # reads are the door's (`with_door_reads` on the mount's table),
    # which judges them itself before a warm serve. A probe answer is
    # served below the guards (`with_probe_answers` on the raw table),
    # so they still judge every path before it. Under a hide or a path
    # rule the native subtree ops are set aside (`scoped_io`), so every
    # entry passes through the guarded walk.
    bound = with_dir_guard(
        with_command_guards(with_policy_guard(finish(stamped)))
    )
    bound = scoped_io(bound, opts.ns, paths or [opts.cwd], opts.mount_prefix)
    return await fn(bound, accessor, paths, texts, opts)


def generic_commands(
    vfs: str,
    *,
    overrides: set[str] | frozenset[str] | None = None,
    table: Callable[[CommandIO], CommandIO] | None = None,
    adapt: dict[str, Callable[[CommandIO], CommandIO]] | None = None,
    local: bool = False,
) -> list[Callable[..., Any]]:
    """Generate the default command set for a backend.

    Each command runs over the table of the mount it runs on
    (``opts.io``), so the set is built once per backend name.

    Args:
        vfs (str): VFS name the commands register under.
        overrides (set[str] | frozenset[str] | None): command names to
            skip (the backend ships its own wrapper for these).
        table (Callable | None): a change to the mount's table for every
            command (disk sets its native ``find`` and ``du`` aside, so a
            shell walk reports partial results and per-directory errors).
        adapt (dict[str, Callable] | None): per-command changes to the
            mount's table, for a command that needs a cheaper backend
            operation (dify's light ``ls``).
        local (bool): whether the backend's data lives on the host, which
            lets a command aggregate there.
    """
    skip = overrides or set()
    changes = adapt or {}
    # A name no builder has does nothing at all, so a misspelled override
    # left the generic registered beside the bespoke one, and an override
    # for a command the table never had (mem0's `search`) read as if it
    # displaced something. Refused at registration, which is import time.
    known = {b.name for b in BUILDERS}
    unknown = sorted((set(skip) | set(changes)) - known)
    if unknown:
        raise ValueError(
            f"generic_commands({vfs!r}): no generic "
            f"builder named {', '.join(unknown)}"
        )
    commands: list[Callable[..., Any]] = []
    for b in BUILDERS:
        if b.name in skip:
            continue
        finish = _write_wraps if b.write and not b.read else _stat_wraps
        bound = functools.partial(
            _run_with_namespace_globs,
            finish,
            b.fn,
            table,
            changes.get(b.name),
            b.write,
        )
        commands.append(
            command(
                b.name,
                vfs=vfs,
                spec=SPECS[b.name],
                aggregate=b.aggregate if local else None,
                write=b.write,
                path_guarded=True,
            )(bound)
        )
    return commands
