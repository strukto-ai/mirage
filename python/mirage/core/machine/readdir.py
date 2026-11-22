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
from mirage.core.machine.place import chosen, kernel_view
from mirage.core.machine.stat import entries, holder_stat
from mirage.core.machine.types import Holder
from mirage.core.posix.types import PosixEntry
from mirage.errors.fs import enotdir
from mirage.types import FileStat, PathSpec

logger = logging.getLogger(__name__)


def _merged(
    accessor: MachineAccessor,
    machines: list[str],
    listed: list[list[PosixEntry]],
    scope: PathSpec,
) -> dict[str, Holder]:
    """Every machine's entries below one directory as one listing, each
    name once: the copy every look at the name goes to (``chosen``). A
    kernel's view of its machine is the one machine's it answers for
    (``kernel_view``), and nothing is listed below a name whose copy
    shown is a file, whatever an older folder there holds.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machines (list[str]): the machines listed, in order.
        listed (list[list[PosixEntry]]): what each printed, the
            directory's own entry left out.
        scope (PathSpec): the directory.
    """
    held: dict[str, list[Holder]] = {}
    for machine, found in zip(machines, listed):
        for entry in found:
            held.setdefault(entry.rel, []).append(Holder(machine, entry))
    several = len(machines) > 1
    merged: dict[str, Holder] = {}
    over: set[str] = set()
    for rel, copies in held.items():
        own = kernel_view(accessor, scope, rel) if several else None
        if own is not None:
            copies = [one for one in copies if one.machine == own]
            if not copies:
                continue
        merged[rel] = chosen(accessor, copies)
        if not merged[rel].folder and any(one.folder for one in copies):
            over.add(rel)
    if not over:
        return merged
    return {
        rel: one
        for rel, one in merged.items()
        if not any(
            rel[:cut] in over for cut in range(len(rel)) if rel[cut] == "/"
        )
    }


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

    Raises:
        NotADirectoryError: the copy shown of the directory is a file.
    """
    scope = path_spec.dir if path_spec.pattern else path_spec
    found = await asyncio.gather(
        *(entries(accessor, m, scope, 1) for m in machines),
        return_exceptions=True,
    )
    tops: list[Holder] = []
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
        tops.append(Holder(machine, result[0]))
        if result[0].kind != "d":
            failure = enotdir(scope)
            continue
        listing.append(machine)
        listed.append(result[1:])
    if not listing:
        assert failure is not None
        raise failure
    if not chosen(accessor, tops).folder:
        raise enotdir(scope)
    merged = _merged(accessor, listing, listed, scope)
    return [holder_stat(name, merged[name]) for name in sorted(merged)]


async def tree(
    accessor: MachineAccessor, machines: list[str], path: PathSpec
) -> dict[str, Holder] | None:
    """The copy shown of every entry under a directory on the machines
    that hold it, by its path there, merged as a listing merges them,
    from one find on each, where a walk sends a listing per directory.
    None when a machine's find fails or finds no directory, which leaves
    the walk to readdir, which reports it.

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
    return _merged(accessor, machines, listed, path)
