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
from mirage.core.machine.utils import checked
from mirage.types import CapacityResult, CapacityState, PathSpec
from mirage.utils.quote import single_quote


async def capacity(
    accessor: MachineAccessor, path: PathSpec
) -> CapacityResult:
    """The space of the filesystem the root sits on, on the default
    machine, from its ``df -Pk``; UNKNOWN when it cannot say.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the mount root, for an error.
    """
    target = single_quote(accessor.root)
    out = await checked(
        accessor, accessor.default_machine, f"df -Pk -- {target}", path
    )
    lines = out.decode(errors="replace").strip().split("\n")
    fields = lines[-1].split() if len(lines) > 1 else []
    if len(fields) < 4 or not all(f.isdigit() for f in fields[1:4]):
        return CapacityResult(state=CapacityState.UNKNOWN)
    total, used, available = (int(f) * 1024 for f in fields[1:4])
    return CapacityResult(
        state=CapacityState.QUOTA, total=total, used=used, available=available
    )
