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

from typing import Any

from mirage.accessor.bin import BinAccessor
from mirage.errors.fs import erofs
from mirage.types import PathSpec


async def refuse(
    accessor: BinAccessor, path: PathSpec, *args: Any, **kwargs: Any
) -> None:
    """Refuse a write into the view, as a read-only file system does.

    What the view holds is the lookup's to say, so every write op lands
    here, whatever it would have done.

    Args:
        accessor (BinAccessor): Accessor holding the lookup.
        path (PathSpec): The path the op writes; a rename's source.
    """
    raise erofs(path.virtual)
