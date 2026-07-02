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

import dataclasses

from mirage.cache.file.mixin import FileCacheMixin
from mirage.commands.resolve import get_extension
from mirage.commands.spec import parse_command, parse_to_kwargs
from mirage.provision import Precision, ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session


async def _check_cache_hits(
    cache: FileCacheMixin | None,
    parts: list[str | PathSpec],
) -> int:
    """Count how many path args are already cached."""
    if cache is None:
        return 0
    hits = 0
    for p in parts[1:]:
        if isinstance(p, PathSpec) and await cache.exists(p.virtual):
            hits += 1
    return hits


async def handle_command_provision(
    registry: MountRegistry,
    parts: list[str | PathSpec],
    session: Session,
) -> ProvisionResult:
    """Estimate cost of a simple command."""
    if not parts:
        return ProvisionResult(precision=Precision.EXACT)

    cmd_name = str(parts[0])
    cmd_str = " ".join(p.virtual if isinstance(p, PathSpec) else p
                       for p in parts)

    first_scope = None
    for p in parts[1:]:
        if isinstance(p, PathSpec):
            first_scope = p
            break
    mount_path = first_scope.virtual if first_scope else session.cwd

    try:
        mount = registry.mount_for(mount_path)
    except ValueError:
        # Pathless commands (seq, date, ...) still need a mount to
        # resolve their registration; any mount carries the general
        # commands, so fall back to the first one.
        mounts = registry.mounts()
        if not mounts:
            return ProvisionResult(command=cmd_str,
                                   precision=Precision.UNKNOWN)
        mount = mounts[0]

    extension = get_extension(first_scope.virtual) if first_scope else None
    cmd = mount.resolve_command(cmd_name, extension)
    if cmd is None or cmd.provision_fn is None:
        return ProvisionResult(command=cmd_str, precision=Precision.UNKNOWN)

    mount_prefix = mount.prefix.rstrip("/")
    resource_scopes = []
    for i, p in enumerate(parts[1:], start=1):
        if isinstance(p, PathSpec):
            scoped = dataclasses.replace(p,
                                         resource_path=mount_key(
                                             p.virtual, mount_prefix))
            parts[i] = scoped
            resource_scopes.append(scoped)

    # Parse flags so plan functions receive them as kwargs (e.g. r=True)
    argv = [p.virtual if isinstance(p, PathSpec) else p for p in parts[1:]]
    spec = mount.spec_for(cmd_name)
    if spec is not None:
        parsed = parse_command(spec, argv, cwd=session.cwd)
        flag_kwargs = parse_to_kwargs(parsed)
        text_args = parsed.texts()
    else:
        flag_kwargs = {}
        text_args = [p for p in parts[1:] if not isinstance(p, PathSpec)]

    result = await cmd.provision_fn(mount.resource.accessor,
                                    resource_scopes,
                                    *text_args,
                                    command=cmd_str,
                                    prefix=mount.prefix.rstrip("/"),
                                    index=mount.resource.index,
                                    **flag_kwargs)
    if not result.command:
        result.command = cmd_str

    hits = await _check_cache_hits(registry.file_cache, parts)
    if hits > 0:
        result.cache_hits = hits
        result.cache_read_low = result.network_read_low
        result.cache_read_high = result.network_read_high
        result.network_read_low = 0
        result.network_read_high = 0

    return result
