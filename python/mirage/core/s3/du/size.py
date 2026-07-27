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

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.s3._client import _client_kwargs, _key, async_session
from mirage.types import PathSpec


async def size(accessor: S3Accessor,
               path_spec: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> int:
    """Recursive byte size of everything under a prefix.

    Args:
        accessor (S3Accessor): S3 accessor.
        path_spec (PathSpec): target path.
    """
    config = accessor.config
    stem = _key(path_spec.mount_path, config).rstrip("/")
    base = (stem + "/") if stem else ""
    total = 0
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        paginator = client.get_paginator("list_objects_v2")
        async for page in paginator.paginate(Bucket=config.bucket,
                                             Prefix=stem):
            for obj in page.get("Contents") or []:
                okey = obj["Key"]
                if okey == stem or okey.startswith(base):
                    total += obj.get("Size", 0)
    return total
