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

import httpx

from mirage.accessor.base import Accessor
from mirage.resource.jaeger.config import JaegerConfig


class JaegerAccessor(Accessor):

    def __init__(self, config: JaegerConfig) -> None:
        self.config = config
        self._client: httpx.AsyncClient | None = None

    def get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.config.host.rstrip("/"),
                timeout=self.config.request_timeout,
            )
        return self._client

    async def request(self, endpoint: str,
                      params: dict[str, Any] | None = None) -> httpx.Response:
        return await self.get_client().get(endpoint, params=params)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
