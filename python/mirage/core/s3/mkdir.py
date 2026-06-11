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
from mirage.cache.context import invalidate_after_write
from mirage.core.s3._client import _client_kwargs, _prefix, async_session
from mirage.types import PathSpec


async def mkdir(accessor: S3Accessor,
                path: PathSpec,
                parents: bool = False) -> None:
    # Object stores have no real directories; parents is implicit.
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        path = path.strip_prefix
    config = accessor.config
    pfx = _prefix(path, config)
    if pfx:
        session = async_session(config)
        async with session.client(**_client_kwargs(config)) as client:
            await client.put_object(Bucket=config.bucket, Key=pfx, Body=b"")
        await invalidate_after_write(path)
