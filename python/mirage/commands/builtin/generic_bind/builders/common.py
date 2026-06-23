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

from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.types import PathSpec


async def resolve_or_empty(ops: CommandIO, accessor: object,
                           paths: list[PathSpec],
                           index: object) -> list[PathSpec]:
    if paths and ops.is_mounted(accessor):
        return await ops.resolve_glob(accessor, paths, index)
    return []
