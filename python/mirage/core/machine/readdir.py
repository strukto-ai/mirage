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

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine.stat import row_stat, rows
from mirage.core.posix.types import TreeRow
from mirage.errors.fs import enotdir
from mirage.types import FileStat, PathSpec


async def readdir(
    accessor: MachineAccessor, machines: list[str], path_spec: PathSpec
) -> list[FileStat]:
    """A directory's children on every machine that holds it, each name
    once, from one find on each machine. A machine that lacks it, or holds
    a file there, is passed over; any other failure fails the listing, so
    no machine's files go missing unseen.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machines (list[str]): the machines to list.
        path_spec (PathSpec): the directory, or a glob in it.
    """
    scope = path_spec.dir if path_spec.pattern else path_spec
    found = await asyncio.gather(
        *(rows(accessor, m, scope, 1) for m in machines),
        return_exceptions=True,
    )
    merged: dict[str, TreeRow] = {}
    failure: OSError | None = None
    listed = False
    for result in found:
        if isinstance(result, BaseException):
            if not isinstance(result, FileNotFoundError):
                raise result
            failure = failure or result
            continue
        if result[0].kind != "d":
            failure = enotdir(scope)
            continue
        listed = True
        for row in result[1:]:
            merged.setdefault(row.rel, row)
    if not listed:
        assert failure is not None
        raise failure
    return [row_stat(name, merged[name]) for name in sorted(merged)]
