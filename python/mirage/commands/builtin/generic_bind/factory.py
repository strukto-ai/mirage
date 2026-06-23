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
from mirage.commands.builtin.generic_bind.adapter import (
    FACTORY_READ_RESOURCES, CommandIO)
from mirage.commands.builtin.generic_bind.builders import _BUILDERS
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.types import PathSpec


def _cached_read_stream(read_stream: Callable, accessor: Accessor,
                        path: PathSpec, *args, **kwargs):
    manager = active_cache_manager()
    return _cached_stream(manager, read_stream, accessor, path, *args,
                          **kwargs)


async def _cached_stream(manager, read_stream: Callable, accessor: Accessor,
                         path: PathSpec, *args, **kwargs):
    if manager is not None and isinstance(path, PathSpec):
        cached = await manager.cached_bytes(path)
        if cached is not None:
            yield cached
            return
    async for chunk in read_stream(accessor, path, *args, **kwargs):
        yield chunk


async def _cached_read_bytes(read_bytes: Callable, accessor: Accessor,
                             path: PathSpec, *args, **kwargs) -> bytes:
    manager = active_cache_manager()
    if manager is not None and isinstance(path, PathSpec):
        cached = await manager.cached_bytes(path)
        if cached is not None:
            return cached
    return await read_bytes(accessor, path, *args, **kwargs)


def with_read_cache(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose byte reads serve cached bytes when warm.

    The factory hands this to every ``read=True`` command so a warm read
    is served from the file cache without the command knowing about it,
    mirroring how readdir/stat already serve the index cache inside the
    op. The manager is captured eagerly (when the ops method is called,
    inside the command's cache-manager scope) rather than read lazily at
    stream-drain time, when that scope is already gone.
    ``CacheManager.cached_bytes`` is a no-op (returns None) for local or
    non-caching mounts, so this is safe to apply uniformly.

    Args:
        ops (CommandIO): the backend's IO adapter.
    """
    return replace(
        ops,
        read_stream=functools.partial(_cached_read_stream, ops.read_stream),
        read_bytes=functools.partial(_cached_read_bytes, ops.read_bytes),
    )


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
    FACTORY_READ_RESOURCES.add(resource)
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
        read_ops = with_read_cache(ops) if b.read else ops
        bound = functools.partial(b.fn, read_ops)
        if b.name in prov_over:
            provision = prov_over[b.name]
        elif b.provision is not None:
            provision = b.provision(ops.stat)
        else:
            provision = None
        agg = b.aggregate if ops.local else None
        commands.append(
            command(b.name,
                    resource=resource,
                    spec=SPECS[b.name],
                    provision=provision,
                    aggregate=agg,
                    write=b.write)(bound))
    return commands
