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

from mirage.accessor.base import Accessor
from mirage.cache.context import active_cache_manager
from mirage.cache.read_through import (cache_aware_read_bytes,
                                       cache_aware_read_stream)
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders import _BUILDERS
from mirage.commands.builtin.generic_bind.provision import default_provision
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.types import PathSpec


def _cached_stat(stat: Callable, accessor: Accessor, path: PathSpec, *args,
                 **kwargs):
    manager = active_cache_manager()
    return _cached_stat_result(manager, stat, accessor, path, *args, **kwargs)


async def _cached_stat_result(manager, stat: Callable, accessor: Accessor,
                              path: PathSpec, *args, **kwargs):
    result = await stat(accessor, path, *args, **kwargs)
    if (result is not None and getattr(result, "size", None) is None
            and manager is not None and isinstance(path, PathSpec)):
        cached = await manager.cached_bytes(path)
        if cached is not None:
            result = result.model_copy(update={"size": len(cached)})
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
    return replace(
        with_stat_cache(ops),
        read_stream=cache_aware_read_stream(ops.read_stream),
        read_bytes=cache_aware_read_bytes(ops.read_bytes),
    )


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


def make_generic_commands(
    resource: str,
    ops: CommandIO,
    *,
    overrides: set[str] | None = None,
    provision_overrides: dict[str, Callable] | None = None,
) -> list[Callable]:
    """Generate the default command set for a backend from its ops.

    Args:
        resource (str): resource name the commands register under.
        ops (CommandIO): the backend's IO adapter.
        overrides (set[str] | None): command names to skip (the backend
            ships its own wrapper for these).
        provision_overrides (dict[str, Callable] | None): per-command
            provision functions that replace the catalog default (for a
            backend whose cost model genuinely differs).
    """
    skip = overrides or set()
    prov_over = provision_overrides or {}
    commands: list[Callable] = []
    for b in _BUILDERS:
        if b.name in skip:
            continue
        # A read-only backend (no write op) can't run the byte-mutation
        # commands (cp/mv/tee/gunzip/...), so don't register a command that
        # would crash when invoked.
        if b.write and ops.write is None:
            continue
        if b.read:
            cmd_ops = with_read_cache(ops)
        elif not b.write:
            cmd_ops = with_stat_cache(ops)
        else:
            cmd_ops = ops
        bound = functools.partial(b.fn, cmd_ops)
        if b.name in prov_over:
            provision = prov_over[b.name]
        elif b.provision is not None:
            provision = b.provision(ops.stat)
        else:
            provision = default_provision(b.name,
                                          ops.stat,
                                          resolve_glob=ops.resolve_glob,
                                          readdir=ops.readdir)
        agg = b.aggregate if ops.local else None
        commands.append(
            command(b.name,
                    resource=resource,
                    spec=SPECS[b.name],
                    provision=provision,
                    aggregate=agg,
                    write=b.write)(bound))
    return commands
