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

from mirage.accessor.disk import DiskAccessor
from mirage.commands.builtin.generic.mktemp import mktemp as generic_mktemp
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.disk.mkdir import mkdir as local_mkdir
from mirage.core.disk.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("mktemp", resource="disk", spec=SPECS["mktemp"], write=True)
async def mktemp(
    accessor: DiskAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    d: bool = False,
    p: str | None = None,
    t: bool = False,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    return await generic_mktemp(*texts,
                                mkdir_fn=local_mkdir,
                                write_bytes_fn=write_bytes,
                                accessor=accessor,
                                d=d,
                                p=p,
                                t=t)
