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

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine.readdir import tree_machines
from mirage.core.posix.search import (
    files_containing as posix_files_containing,
)
from mirage.types import PathSpec


async def files_containing(
    accessor: MachineAccessor,
    machines: list[str],
    path: PathSpec,
    text: str,
    ignore_case: bool,
) -> list[PathSpec] | None:
    """The files under a directory holding ``text``, by grep on each
    machine that holds it; any machine that cannot answer leaves every
    file to be read. A file several machines hold counts by the copy
    shown, as a read of it finds it: a match in an older copy is none.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machines (list[str]): the machines holding the directory.
        path (PathSpec): the directory.
        text (str): the plain text.
        ignore_case (bool): fold ASCII case.
    """
    found: list[list[PathSpec]] = []
    for machine in machines:
        matched = await posix_files_containing(
            accessor.runner(machine), accessor.root, text, [path], ignore_case
        )
        if matched is None:
            return None
        found.append(matched)
    if not any(found):
        return []
    shown = None
    if len(machines) > 1:
        shown = await tree_machines(accessor, machines, path)
        if shown is None:
            return None
    under = path.virtual.rstrip("/") + "/"
    hits: dict[str, PathSpec] = {}
    for machine, matched in zip(machines, found):
        for p in matched:
            if shown is None or shown.get(p.virtual[len(under) :]) == machine:
                hits[p.virtual] = p
    return [hits[name] for name in sorted(hits)]
