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
from mirage.commands.builtin.generic.crossmount import is_cross_mount
from mirage.commands.resolve import get_extension
from mirage.commands.spec import parse_command, parse_to_kwargs
from mirage.provision import Precision, ProvisionResult, combine_sum
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
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


def _mount_groups(registry: MountRegistry,
                  parts: list[str | PathSpec]) -> list[list[PathSpec]]:
    """Group path args by their own mount, in first-appearance order.

    Args that resolve to no mount (glob patterns, expression operands)
    ride with the first group: they scoped to the primary mount before
    and must not fabricate a cross-mount split.
    """
    groups: list[list[PathSpec]] = []
    seen: dict[str, int] = {}
    unresolved: list[PathSpec] = []
    for p in parts[1:]:
        if not isinstance(p, PathSpec):
            continue
        if p.pattern:
            # Globs are not expanded during planning; a pattern operand
            # (find -name, ls *.txt) must not fabricate a mount group.
            unresolved.append(p)
            continue
        try:
            prefix = registry.mount_for(p.virtual).prefix
        except ValueError:
            unresolved.append(p)
            continue
        idx = seen.get(prefix)
        if idx is None:
            seen[prefix] = len(groups)
            groups.append([p])
        else:
            groups[idx].append(p)
    if unresolved:
        if groups:
            groups[0].extend(unresolved)
        else:
            groups.append(unresolved)
    return groups


async def handle_command_provision(
    registry: MountRegistry,
    parts: list[str | PathSpec],
    session: Session,
    namespace: Namespace | None = None,
) -> ProvisionResult:
    """Estimate cost of a simple command.

    Paths are namespace-followed first (a symlinked read costs its
    target, and the cache-hit check sees the entry the executor would
    actually serve), then grouped by mount: a command spanning mounts
    is estimated per mount against each mount's own backend and the
    results summed, instead of statting foreign paths against the
    first path's backend.
    """
    if not parts:
        return ProvisionResult(precision=Precision.EXACT)

    if namespace is not None:
        for i, p in enumerate(parts):
            if isinstance(p, PathSpec):
                followed = namespace.follow(p.virtual)
                if followed != p.virtual:
                    parts[i] = PathSpec.from_str_path(followed)

    cmd_name = str(parts[0])
    cmd_str = " ".join(p.virtual if isinstance(p, PathSpec) else p
                       for p in parts)

    groups = _mount_groups(registry, parts)
    if len(groups) > 1:
        path_parts = [p for p in parts[1:] if isinstance(p, PathSpec)]
        if not is_cross_mount(cmd_name, path_parts, registry):
            # The executor rejects this command across mounts, so an
            # aggregated byte estimate would cost a run that errors.
            return ProvisionResult(command=cmd_str,
                                   precision=Precision.UNKNOWN)
        texts = [p for p in parts[1:] if not isinstance(p, PathSpec)]
        children = []
        for group in groups:
            sub: list[str | PathSpec] = [cmd_name, *texts, *group]
            children.append(await
                            handle_command_provision(registry, sub, session))
        combined = combine_sum(";", children)
        combined.command = cmd_str
        return combined

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
