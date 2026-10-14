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
import shutil

import aiofiles.os

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.errors import disk_error
from mirage.core.disk.utils import resolve_inside
from mirage.types import PathSpec


async def copy(
    accessor: DiskAccessor, src_spec: PathSpec, dst_spec: PathSpec
) -> None:
    root = accessor.root
    s = await resolve_inside(root, src_spec)
    d = await resolve_inside(root, dst_spec)
    try:
        await asyncio.to_thread(shutil.copyfile, s, d)
        await asyncio.to_thread(shutil.copystat, s, d)
    except OSError as exc:
        # copyfile reports ENOENT both for a missing source and for a missing
        # destination parent, so the operand to blame is only knowable
        # after the failure: probe the source to tell them apart. Either
        # way the host path never reaches the message.
        blame_src = isinstance(
            exc, FileNotFoundError
        ) and not await aiofiles.os.path.exists(s)
        spec = src_spec if blame_src else dst_spec
        raise disk_error(exc, spec.virtual) from exc
