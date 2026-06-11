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
from mirage.core.s3._client import _client_kwargs, _key, async_session
from mirage.types import PathSpec


async def truncate(accessor: S3Accessor, path: PathSpec, length: int) -> None:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        path = path.strip_prefix
    config = accessor.config
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        try:
            resp = await client.get_object(Bucket=config.bucket,
                                           Key=_key(path, config))
            data = await resp["Body"].read()
        except Exception as exc:
            if (hasattr(exc, "response") and exc.response.get(
                    "Error", {}).get("Code") == "NoSuchKey"):
                data = b""
            else:
                raise
        result = data[:length].ljust(length, b"\0")
        await client.put_object(Bucket=config.bucket,
                                Key=_key(path, config),
                                Body=result)
    await invalidate_after_write(path)
