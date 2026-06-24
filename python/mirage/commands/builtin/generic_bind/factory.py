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
import logging
from collections.abc import Callable

from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders import _BUILDERS
from mirage.commands.config import command
from mirage.commands.spec import SPECS

logger = logging.getLogger(__name__)


def unsupported_commands(ops: CommandIO,
                         overrides: set[str] | None = None) -> list[str]:
    """Write commands the factory skips because the backend is read-only.

    A read-only backend supplies no ``write`` op, so the byte-mutation
    commands (tee, cp, gunzip, ...) cannot run and are dropped rather than
    registered as commands that would crash when invoked. Used by
    ``make_generic_commands`` and to report coverage gaps.

    Args:
        ops (CommandIO): the backend's IO adapter.
        overrides (set[str] | None): command names the backend ships itself.
    """
    if ops.write is not None:
        return []
    skip = overrides or set()
    return [b.name for b in _BUILDERS if b.write and b.name not in skip]


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
    gaps = unsupported_commands(ops, skip)
    if gaps:
        logger.info("%s: skipped %d unsupported commands: %s", resource,
                    len(gaps), ", ".join(sorted(gaps)))
    commands: list[Callable] = []
    for b in _BUILDERS:
        if b.name in skip or b.name in gaps:
            continue
        bound = functools.partial(b.fn, ops)
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
