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

from mirage.core.object_store.driver import A, ExistsFn, StatFn
from mirage.types import PathSpec


def make_exists(stat: StatFn[A]) -> ExistsFn[A]:
    """Build the boolean existence probe over the backend's stat.

    Args:
        stat (StatFn): the backend's stat, kit-derived or native.
    """

    async def exists(accessor: A, path: PathSpec) -> bool:
        try:
            await stat(accessor, path)
            return True
        except (FileNotFoundError, ValueError):
            return False

    return exists
