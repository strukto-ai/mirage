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

import asyncio
from urllib.parse import quote

import aiohttp

from mirage.accessor.hf_buckets import HfBucketsConfig
from mirage.resource.secrets import reveal_secret
from mirage.utils import key_prefix as kp


def _key(path: str, config: HfBucketsConfig) -> str:
    return kp.apply(config.key_prefix or "", path)


def _prefix(path: str, config: HfBucketsConfig) -> str:
    return kp.apply_dir(config.key_prefix or "", path)


def _strip_prefix(key: str, config: HfBucketsConfig) -> str:
    return kp.strip(config.key_prefix or "", key)


def _bucket_url(config: HfBucketsConfig) -> str:
    return f"{config.endpoint}/api/buckets/{config.bucket}"


def _tree_url(endpoint: str, bucket_id: str, path: str) -> str:
    base = f"{endpoint}/api/buckets/{bucket_id}/tree"
    return f"{base}/{quote(path, safe='/')}" if path else base


def _paths_info_url(endpoint: str, bucket_id: str) -> str:
    return f"{endpoint}/api/buckets/{bucket_id}/paths-info"


def _resolve_url(endpoint: str, bucket_id: str, path: str) -> str:
    return f"{endpoint}/buckets/{bucket_id}/resolve/{quote(path, safe='/')}"


def _headers(config: HfBucketsConfig) -> dict[str, str]:
    token = reveal_secret(config.token)
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


class HfBucketsClient:

    def __init__(self, config: HfBucketsConfig) -> None:
        self._config = config
        self._bucket_id: str | None = None
        self._lock = asyncio.Lock()

    async def session(self) -> aiohttp.ClientSession:
        timeout = aiohttp.ClientTimeout(total=self._config.timeout)
        return aiohttp.ClientSession(headers=_headers(self._config),
                                     timeout=timeout)

    async def bucket_id(self) -> str:
        if self._bucket_id is not None:
            return self._bucket_id
        async with self._lock:
            if self._bucket_id is not None:
                return self._bucket_id
            async with await self.session() as session:
                async with session.get(_bucket_url(self._config)) as resp:
                    resp.raise_for_status()
                    data = await resp.json()
            if "id" not in data:
                raise RuntimeError(f"HF API response missing 'id' for bucket "
                                   f"{self._config.bucket}: {data}")
            self._bucket_id = data["id"]
            return self._bucket_id
