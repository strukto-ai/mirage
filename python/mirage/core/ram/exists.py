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

from mirage.accessor.ram import RAMAccessor
from mirage.types import PathSpec
from mirage.utils.path import norm


async def exists(accessor: RAMAccessor, path_spec: str | PathSpec) -> bool:
    path = path_spec.mount_path if isinstance(path_spec,
                                              PathSpec) else path_spec
    store = accessor.store
    p = norm(path)
    return p in store.files or p in store.dirs
