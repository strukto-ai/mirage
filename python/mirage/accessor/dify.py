import aiohttp

from mirage.accessor.base import SessionAccessor
from mirage.concurrency import ConcurrencyLimiter
from mirage.resource.dify.config import DifyConfig


class DifyAccessor(SessionAccessor):

    def __init__(self, config: DifyConfig) -> None:
        super().__init__(timeout=aiohttp.ClientTimeout(
            total=config.request_timeout))
        self.config = config
        self._request_limiter = ConcurrencyLimiter(config.max_concurrency)
