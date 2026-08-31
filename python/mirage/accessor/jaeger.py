import aiohttp

from mirage.accessor.base import SessionAccessor
from mirage.resource.jaeger.config import JaegerConfig


class JaegerAccessor(SessionAccessor):

    def __init__(self, config: JaegerConfig) -> None:
        super().__init__(timeout=aiohttp.ClientTimeout(
            total=config.request_timeout))
        self.config = config
