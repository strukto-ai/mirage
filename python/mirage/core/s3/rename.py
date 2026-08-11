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
from mirage.core.s3.exists import exists
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def rename(accessor: S3Accessor, src_spec: PathSpec,
                 dst_spec: PathSpec) -> None:
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    config = accessor.config
    if _key(src, config) == _key(dst, config):
        # POSIX rename(2): the same existing file succeeds and performs no
        # other action. Reaching the copy+delete pair below would instead
        # delete the object on any store that accepts the self-copy, and
        # error on the ones that reject it (#150).
        if not await exists(accessor, src_spec):
            raise enoent(src_spec)
        return
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
    await invalidate_after_write(dst_spec)
    await invalidate_after_unlink(src_spec)
