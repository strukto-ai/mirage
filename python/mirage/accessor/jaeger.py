from mirage.accessor.base import SessionAccessor
from mirage.vfs.jaeger.config import JaegerConfig


class JaegerAccessor(SessionAccessor):
    def __init__(self, config: JaegerConfig) -> None:
        super().__init__(timeout=config.timeout)
        self.config = config
