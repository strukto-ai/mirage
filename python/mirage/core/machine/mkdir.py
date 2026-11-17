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
from mirage.core.machine.utils import checked, remote
from mirage.types import PathSpec
from mirage.utils.quote import single_quote


async def mkdir(
    accessor: MachineAccessor, machine: str, path: PathSpec, parents: bool
) -> None:
    target = single_quote(remote(accessor, path))
    flag = " -p" if parents else ""
    await checked(accessor, machine, f"mkdir{flag} -- {target}", path)
