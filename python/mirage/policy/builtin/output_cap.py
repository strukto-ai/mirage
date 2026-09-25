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

from collections.abc import Callable, Iterable, Mapping
from typing import Any

from mirage.policy.base import Policy
from mirage.policy.types import Action, OpsResultContext
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
    workspace_limits: Mapping[str, Limit] | None = None,
    profile_limits: Mapping[str, Limit] | None = None,
) -> Limit | None:
    """Resolve one command's bound, the one precedence engine.

    Profile override, mount override, workspace default, command default,
    then the built-in table. Each selected entry replaces the whole Limit;
    absent command names inherit. Multiple mounts aggregate to the tightest
    bound after resolution. Independent policy ceilings compose separately.

    Args:
        name (str): command name being resolved.
        mounts (Iterable): the mounts the command spans (may be empty).
        command_default (Limit | None): the registered command's own
            default, when the caller knows it.
        mount_override (Limit | None): one mount's per-command
            override, when the caller knows it.
    """
    if profile_limits is not None and name in profile_limits:
        return profile_limits[name]
    if mount_override is not None:
        return mount_override
    spanned = list(mounts)
    if spanned:
        return Limit.aggr(
            resolve_limit(name,
                          command_default=command_default,
                          mount_override=m.command_limits.get(name),
                          workspace_limits=workspace_limits) for m in spanned)
    if workspace_limits is not None and name in workspace_limits:
        return workspace_limits[name]
    if command_default is not None:
        return command_default
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


def resolve_producer(
        producer: Producer,
        override_for: OverrideLookup,
        workspace_limits: Mapping[str, Limit] | None = None,
        profile_limits: Mapping[str, Limit] | None = None) -> Limit | None:
    """Resolve the bound a producer's facts name.

    Shared by command output guards and dispatch timeouts. Resolution
    uses the same profile, mount, workspace and command precedence,
    aggregated to the tightest value across the spanned mounts.

    Args:
        producer (Producer): facts stamped at the dispatch site.
        override_for (OverrideLookup): (prefix, name) -> that mount's
            configured override.
    """
    if not producer.command:
        return None
    if not producer.prefixes:
        return resolve_limit(producer.command,
                             command_default=producer.declared,
                             workspace_limits=workspace_limits,
                             profile_limits=profile_limits)
    per_mount = [
        resolve_limit(producer.command,
                      command_default=producer.declared,
                      mount_override=override_for(prefix, producer.command),
                      workspace_limits=workspace_limits,
                      profile_limits=profile_limits)
        for prefix in producer.prefixes
    ]
    return Limit.aggr(per_mount)


class OutputCapPolicy(Policy):
    """The built-in output cap, seeded by the registry.

    Answers post_ops with a mount's per-op bound. Command output is finalized
    at its terminal destination using resolve_producer; post_execute remains
    the hook for explicit whole-invocation policies.

    Args:
        override_for (OverrideLookup): maps (mount prefix, command or
            op name) to that mount's configured override, injected by
            the registry so this module stays a leaf.
    """

    def __init__(self, override_for: OverrideLookup) -> None:
        self._override_for = override_for

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        return self._override_for(ctx.prefix, ctx.op)
