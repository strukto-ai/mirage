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
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.s3._client import _client_kwargs, _key, async_session
from mirage.types import PathSpec


async def rename(accessor: S3Accessor, src: PathSpec, dst: PathSpec) -> None:
    if isinstance(src, str):
        src = PathSpec(original=src, directory=src)
    if isinstance(src, PathSpec):
        src = src.strip_prefix
    if isinstance(dst, str):
        dst = PathSpec(original=dst, directory=dst)
    if isinstance(dst, PathSpec):
        dst = dst.strip_prefix
    config = accessor.config
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        await client.copy_object(
            Bucket=config.bucket,
            CopySource={
                "Bucket": config.bucket,
                "Key": _key(src, config)
            },
            Key=_key(dst, config),
        )
        await client.delete_object(Bucket=config.bucket, Key=_key(src, config))
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
