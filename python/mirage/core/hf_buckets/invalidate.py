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

from mirage.cache.context import invalidate_after_write
from mirage.types import PathSpec


async def invalidate_ancestors(path: PathSpec) -> None:
    """Evict every ancestor directory listing of ``path``.

    Buckets have no directory markers, so a write or delete materializes
    or removes directories arbitrarily far up the tree; backends with
    markers refresh ancestors through their marker writes instead.

    Args:
        path (PathSpec): Mount-relative path that was mutated.
    """
    parent = path.mount_path.rsplit("/", 1)[0]
    while parent:
        await invalidate_after_write(PathSpec.from_str_path(parent))
        parent = parent.rsplit("/", 1)[0]
