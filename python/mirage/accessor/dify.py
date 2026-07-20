from typing import Any

import httpx

from mirage.accessor.base import Accessor
from mirage.concurrency import ConcurrencyLimiter
from mirage.resource.dify.config import DifyConfig


class DifyAccessor(Accessor):

    def __init__(self, config: DifyConfig) -> None:
        self.config = config
        self._client: httpx.AsyncClient | None = None
        self._request_limiter = ConcurrencyLimiter(config.max_concurrency)

    def get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.config.base_url,
                headers={"Authorization": f"Bearer {self.config.api_key}"},
                timeout=self.config.request_timeout,
            )
        return self._client

    async def request(self, method: str, endpoint: str,
                      **kwargs: Any) -> httpx.Response:
        async with self._request_limiter.acquire():
            return await self.get_client().request(method, endpoint, **kwargs)

    async def close(self) -> None:
        if self._client is None:
            return
        await self._client.aclose()
        self._client = None
