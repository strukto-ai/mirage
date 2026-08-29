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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.sharepoint.identity import live_identity as core_live_identity
from mirage.ops.registry import op
from mirage.ops.types import LiveFileIdentity
from mirage.types import PathSpec


@op("live_identity", resource="sharepoint")
async def live_identity(accessor: SharePointAccessor,
                        path: PathSpec,
                        *,
                        index: IndexCacheStore | None = None,
                        **kwargs: Any) -> LiveFileIdentity:
    """Bounded identity lookup, bypassing the index cache entirely.

    Args:
        accessor (SharePointAccessor): backend accessor.
        path (PathSpec): the path to check.
        index (IndexCacheStore | None): injected index cache;
            never consulted.
    """
    return await core_live_identity(accessor, path)
