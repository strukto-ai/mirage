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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import NULL_INDEX
from mirage.core.ssh.read import read_bytes
from mirage.core.ssh.write import write_bytes
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("truncate", resource="ssh", write=True)
async def truncate(accessor: SSHAccessor, path: PathSpec, length: int,
                   **kwargs) -> None:
    try:
        data = await read_bytes(accessor, path, index=NULL_INDEX)
    except FileNotFoundError:
        data = b""
    await write_bytes(accessor, path, data[:length].ljust(length, b"\0"))
