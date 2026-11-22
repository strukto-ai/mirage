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

import asyncio
import logging

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine.place import chosen
from mirage.core.machine.stat import entries, entry_stat
from mirage.core.machine.types import Holder
from mirage.core.posix.types import PosixEntry
from mirage.errors.fs import enotdir
from mirage.types import FileStat, PathSpec

logger = logging.getLogger(__name__)


def _merged(
    accessor: MachineAccessor,
    machines: list[str],
    listed: list[list[PosixEntry]],
) -> dict[str, PosixEntry]:
    """Every machine's entries below one directory as one listing, each
    name once: the entry of the machine every look at the name goes to
    (``chosen``).

    Args:
        accessor (MachineAccessor): the mount's machines.
        machines (list[str]): the machines listed, in order.
        listed (list[list[PosixEntry]]): what each printed, the
            directory's own entry left out.
    """
    held: dict[str, list[Holder]] = {}
    for machine, found in zip(machines, listed):
        for entry in found:
            held.setdefault(entry.rel, []).append(Holder(machine, entry))
    merged: dict[str, PosixEntry] = {}
    for rel, copies in held.items():
        picked = chosen(accessor, copies).entry
        assert picked is not None
        merged[rel] = picked
    return merged


async def readdir(
    accessor: MachineAccessor, machines: list[str], path_spec: PathSpec
) -> list[FileStat]:
    """A directory's children on every machine that holds it, each name
    once, from one find on each machine. A machine that lacks it, or holds
    a file there or above it, is passed over; any other failure fails the
    listing, so no machine's files go missing unseen.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machines (list[str]): the machines to list.
        path_spec (PathSpec): the directory, or a glob in it.
    """
    scope = path_spec.dir if path_spec.pattern else path_spec
    found = await asyncio.gather(
        *(entries(accessor, m, scope, 1) for m in machines),
        return_exceptions=True,
    )
    listing: list[str] = []
    listed: list[list[PosixEntry]] = []
    failure: OSError | None = None
    for machine, result in zip(machines, found):
        if isinstance(result, BaseException):
            if isinstance(result, NotADirectoryError):
                failure = result
                continue
            if not isinstance(result, FileNotFoundError):
                raise result
            failure = failure or result
            continue
        if result[0].kind != "d":
            failure = enotdir(scope)
            continue
        listing.append(machine)
        listed.append(result[1:])
    if not listing:
        assert failure is not None
        raise failure
    merged = _merged(accessor, listing, listed)
    return [entry_stat(name, merged[name]) for name in sorted(merged)]


async def tree(
    accessor: MachineAccessor, machines: list[str], path: PathSpec
) -> dict[str, FileStat] | None:
    """Every entry under a directory on the machines that hold it, merged
    by path as a listing merges them, from one find on each, where a walk
    sends a listing per directory. A machine whose find fails leaves the
    walk to readdir, which reports it.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machines (list[str]): the machines holding the directory.
        path (PathSpec): the directory.
    """
    found = await asyncio.gather(
        *(entries(accessor, m, path, None) for m in machines),
        return_exceptions=True,
    )
    listed: list[list[PosixEntry]] = []
    for result in found:
        if isinstance(result, BaseException):
            if not isinstance(result, OSError):
                raise result
            logger.debug(
                "%s: one find failed; walking it instead",
                path.virtual,
                exc_info=result,
            )
            return None
        if result[0].kind != "d":
            return None
        listed.append(result[1:])
    merged = _merged(accessor, machines, listed)
    return {
        rel: entry_stat(rel.rsplit("/", 1)[-1], entry)
        for rel, entry in merged.items()
    }
