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
                         overrides: set[str] | None = None) -> dict[str, list]:
    """Commands the factory skips for these ops, mapped to the missing ops.

    A command is skipped when the backend supplies none of the ops it needs
    (e.g. a read-only backend has no ``write`` so ``tee`` cannot run). Used
    by ``make_generic_commands`` to drop them and to report coverage gaps.

    Args:
        ops (CommandIO): the backend's IO adapter.
        overrides (set[str] | None): command names the backend ships itself.
    """
    skip = overrides or set()
    gaps: dict[str, list] = {}
    for b in _BUILDERS:
        if b.name in skip:
            continue
        missing = [op for op in b.requires if getattr(ops, op) is None]
        if missing:
            gaps[b.name] = missing
    return gaps


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
