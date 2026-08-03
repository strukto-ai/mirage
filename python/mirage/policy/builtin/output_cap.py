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

from collections.abc import Callable, Iterable
from typing import Any

from mirage.policy.base import Policy
from mirage.policy.types import Action, ExecuteResultContext, OpsResultContext
from mirage.types import Limit, Producer

_DEFAULT_MAX_LINES = 2000
_DEFAULT_TIMEOUT_SECONDS = 600.0

DEFAULT_COMMAND_LIMITS: dict[str, Limit] = {
    name:
    Limit(max_lines=_DEFAULT_MAX_LINES,
          timeout_seconds=_DEFAULT_TIMEOUT_SECONDS)
    for name in ("cat", "grep", "rg", "head", "tail")
}

FALLBACK_LIMIT = Limit(timeout_seconds=_DEFAULT_TIMEOUT_SECONDS)

OverrideLookup = Callable[[str, str], Limit | None]


def resolve_limit(
    name: str,
    mounts: Iterable[Any] = (),
    command_default: Limit | None = None,
    mount_override: Limit | None = None,
) -> Limit | None:
    """Resolve one command's bound, the one precedence engine.

    Precedence is override semantics, not the container's tighten-only
    merge (an override may loosen a default), which is why it lives
    inside this built-in and nowhere else: an explicit mount_override,
    then the command's own declared default, then aggregation across
    the mounts the command spans (tightest per field), then the global
    table.

    Args:
        name (str): command name being resolved.
        mounts (Iterable): the mounts the command spans (may be empty).
        command_default (Limit | None): the registered command's own
            default, when the caller knows it.
        mount_override (Limit | None): one mount's per-command
            override, when the caller knows it.
    """
    if mount_override is not None:
        return mount_override
    if command_default is not None:
        return command_default
    spanned = list(mounts)
    if spanned:
        return resolve_across_mounts(name, spanned)
    return DEFAULT_COMMAND_LIMITS.get(name, FALLBACK_LIMIT)


def resolve_across_mounts(
    name: str,
    mounts: Iterable[Any],
) -> Limit | None:
    """Resolve and aggregate the bound across the mounts a command spans.

    A command that touches several mounts but yields one stream
    (cross-mount cat, fan-out find/grep -r/du/tree/ls -R) must respect
    every spanned mount's bound, so each mount's per-command override is
    resolved and combined with Limit.aggr (tightest per field).

    Args:
        name (str): command name being resolved.
        mounts (Iterable): the mounts the command spans.
    """
    resolved = [
        resolve_limit(name, mount_override=m.command_limits.get(name))
        for m in mounts
    ]
    return Limit.aggr(resolved)


def resolve_producer(producer: Producer,
                     override_for: OverrideLookup) -> Limit | None:
    """Resolve the bound a producer's facts name.

    Shared by OutputCapPolicy and the dispatch sites that still need
    the resolved timeout locally: per-prefix override first, then the
    producer's declared bound, then the global table, aggregated to
    the tightest value when the command spanned several mounts.

    Args:
        producer (Producer): facts stamped at the dispatch site.
        override_for (OverrideLookup): (prefix, name) -> that mount's
            configured override.
    """
    if not producer.command:
        return None
    if not producer.prefixes:
        return resolve_limit(producer.command,
                             command_default=producer.declared)
    per_mount = [
        resolve_limit(producer.command,
                      command_default=producer.declared,
                      mount_override=override_for(prefix, producer.command))
        for prefix in producer.prefixes
    ]
    return Limit.aggr(per_mount)


class OutputCapPolicy(Policy):
    """The built-in output cap, seeded by the registry.

    Answers post_execute with the resolution the ``command_limits:`` config
    surface promises (override semantics, see resolve_limit) and
    post_ops with a mount's per-op bound. Config parses into this
    policy; the container and dispatch know nothing about caps.

    Args:
        override_for (OverrideLookup): maps (mount prefix, command or
            op name) to that mount's configured override, injected by
            the registry so this module stays a leaf.
    """

    def __init__(self, override_for: OverrideLookup) -> None:
        self._override_for = override_for

    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        return resolve_producer(ctx.producer, self._override_for)

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        return self._override_for(ctx.prefix, ctx.op)
