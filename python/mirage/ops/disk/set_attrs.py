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
from mirage.core.disk.set_attrs import set_attrs as set_attrs_core
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("setattr", resource="disk", write=True)
async def set_attrs(
    accessor: DiskAccessor,
    path: PathSpec,
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
    atime: str | None = None,
    mtime: str | None = None,
    index=None,
    **kwargs,
) -> dict[str, int | str]:
    return await set_attrs_core(accessor,
                                path,
                                mode=mode,
                                uid=uid,
                                gid=gid,
                                atime=atime,
                                mtime=mtime)
