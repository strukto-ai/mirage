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
from typing import Protocol

from mirage.types import JsonValue, Limit, Producer

_DEFAULT_MAX_LINES = 2000

DEFAULT_COMMAND_LIMITS: dict[str, Limit] = {
    name: Limit(max_lines=_DEFAULT_MAX_LINES)
    for name in ("cat", "grep", "rg", "head", "tail")
}

LINE_TIMEOUT_SECONDS = 600.0

ALL_COMMANDS = "*"
LINE = "line"


class LimitMount(Protocol):
    @property
    def command_limits(self) -> Mapping[str, Limit]: ...

    @property
    def default_limit(self) -> Limit: ...


def _entries(
    table: Mapping[str, Limit] | None, name: str
) -> tuple[Limit | None, Limit | None]:
    if table is None:
        return None, None
    return table.get(name), table.get(ALL_COMMANDS)


def resolve_limit(
    name: str,
    mounts: Iterable[LimitMount] = (),
    command_default: Limit | None = None,
    mount_override: Limit | None = None,
    workspace_limits: Mapping[str, Limit] | None = None,
    profile_limits: Mapping[str, Limit] | None = None,
) -> Limit | None:
    """Resolve one command's bound, the one precedence engine.

    Field by field, from the most specific layer that sets it: the
    profile's entry for the command, then its ``"*"`` entry for every
    command, then the mount's two, the workspace's two, the command's
    own default and the built-in table; on a mount, its backend's
    default (``walk_limit``) last. A layer that names one
    bound inherits the rest. A command across several mounts resolves
    on each and keeps the tightest bound.

    Args:
        name (str): command name being resolved.
        mounts (Iterable[LimitMount]): the mounts the command spans (may be empty).
        command_default (Limit | None): the registered command's own
            default, when the caller knows it.
        mount_override (Limit | None): the caller's override, above
            every mount's own entries.
        workspace_limits (Mapping[str, Limit] | None): the workspace
            defaults, keyed by command.
        profile_limits (Mapping[str, Limit] | None): the session
            profile's overrides, keyed by command.
    """
    above = (*_entries(profile_limits, name), mount_override)
    below = (
        *_entries(workspace_limits, name),
        command_default,
        DEFAULT_COMMAND_LIMITS.get(name),
    )
    spanned = list(mounts)
    if not spanned:
        return Limit.layered((*above, *below))
    return Limit.aggr(
        Limit.layered(
            (
                *above,
                *_entries(m.command_limits, name),
                *below,
                m.default_limit,
            )
        )
        for m in spanned
    )


MountLookup = Callable[[str], LimitMount | None]


def resolve_producer(
    producer: Producer,
    mount_at: MountLookup,
    workspace_limits: Mapping[str, Limit] | None = None,
    profile_limits: Mapping[str, Limit] | None = None,
) -> Limit | None:
    """Resolve the bound a producer's facts name.

    Shared by command output guards and dispatch timeouts, through the
    same layers as :func:`resolve_limit` on the mounts its prefixes name.

    Args:
        producer (Producer): facts stamped at the dispatch site.
        mount_at (MountLookup): prefix -> that mount, None for one
            unmounted since the stamp.
        workspace_limits (Mapping[str, Limit] | None): the workspace
            defaults, keyed by command.
        profile_limits (Mapping[str, Limit] | None): the session
            profile's overrides, keyed by command.
    """
    if not producer.command:
        return None
    mounts = [
        m for m in (mount_at(prefix) for prefix in producer.prefixes) if m
    ]
    return resolve_limit(
        producer.command,
        mounts,
        command_default=producer.declared,
        workspace_limits=workspace_limits,
        profile_limits=profile_limits,
    )


def command_limits_to_json(
    limits: Mapping[str, Limit],
) -> dict[str, dict[str, JsonValue]]:
    """A limit table as config spells it, each entry with only the
    fields it names (a None among them), so a stored entry still
    inherits the rest.

    Args:
        limits (Mapping[str, Limit]): the table, keyed by command.
    """
    return {
        name: limit.model_dump(mode="json", include=limit.model_fields_set)
        for name, limit in limits.items()
    }


def line_timeout(
    workspace_limits: Mapping[str, Limit] | None = None,
    profile_limits: Mapping[str, Limit] | None = None,
) -> float | None:
    """The whole line's deadline, the one time limit a line runs under:
    the ``line`` entry's ``timeout_seconds``, the profile's over the
    workspace's, else ``LINE_TIMEOUT_SECONDS``. An entry naming it as
    None or 0 lifts it.

    Args:
        workspace_limits (Mapping[str, Limit] | None): the workspace's
            command limits.
        profile_limits (Mapping[str, Limit] | None): the session
            profile's.
    """
    found = Limit.layered(
        (
            (profile_limits or {}).get(LINE),
            (workspace_limits or {}).get(LINE),
        )
    )
    if found is None or "timeout_seconds" not in found.model_fields_set:
        return LINE_TIMEOUT_SECONDS
    return found.timeout_seconds or None


def check_command_limits(
    limits: Mapping[str, Limit], where: str, *, takes_line: bool
) -> None:
    """Refuse a table that names time where no time limit applies.

    A line runs under one time limit, the ``line`` entry's
    ``timeout_seconds``; no command or op entry takes one, and the
    ``line`` entry takes nothing else. A mount names no line, since a
    line spans mounts.

    Args:
        limits (Mapping[str, Limit]): the table, keyed by command.
        where (str): what the table belongs to, for the message.
        takes_line (bool): whether the table may hold a ``line`` entry.

    Raises:
        ValueError: an entry names a bound it cannot take.
    """
    for name, limit in limits.items():
        if name != LINE:
            if "timeout_seconds" in limit.model_fields_set:
                raise ValueError(
                    f"{where}: command_limits[{name!r}].timeout_seconds:"
                    f" a line has one time limit, set it on {LINE!r}"
                )
            continue
        if not takes_line:
            raise ValueError(
                f"{where}: command_limits[{LINE!r}]: a line spans mounts,"
                " set it on the workspace or a profile"
            )
        extra = sorted(limit.model_fields_set - {"timeout_seconds"})
        if extra:
            raise ValueError(
                f"{where}: command_limits[{LINE!r}] takes only"
                f" timeout_seconds, not {', '.join(extra)}"
            )
