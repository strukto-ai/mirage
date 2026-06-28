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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.sharepoint.truncate import truncate as truncate_impl
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("truncate", resource="sharepoint", write=True)
async def truncate(accessor: SharePointAccessor, path: PathSpec, length: int,
                   **kwargs) -> None:
    await truncate_impl(accessor, path, length)
