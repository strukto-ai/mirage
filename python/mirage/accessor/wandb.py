from mirage.accessor.base import SessionAccessor
from mirage.core.wandb.client import WandbClient
from mirage.core.wandb.config import WandbConfig


class WandbAccessor(SessionAccessor):
    def __init__(self, config: WandbConfig) -> None:
        super().__init__(config.timeout)
        self.config = config
        self.client = WandbClient(config, self.pool)
