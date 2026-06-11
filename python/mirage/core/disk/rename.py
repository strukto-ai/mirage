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

import aiofiles.os

from mirage.accessor.disk import DiskAccessor
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.disk.utils import resolve_safe
from mirage.types import PathSpec


async def rename(accessor: DiskAccessor, src: PathSpec, dst: PathSpec) -> None:
    if isinstance(src, str):
        src = PathSpec(original=src, directory=src)
    if isinstance(src, PathSpec):
        src = src.strip_prefix
    if isinstance(dst, str):
        dst = PathSpec(original=dst, directory=dst)
    if isinstance(dst, PathSpec):
        dst = dst.strip_prefix
    root = accessor.root
    await aiofiles.os.rename(resolve_safe(root, src), resolve_safe(root, dst))
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
