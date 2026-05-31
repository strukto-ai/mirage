from mirage.accessor.base import Accessor
from mirage.resource.dify.config import DifyConfig


class DifyAccessor(Accessor):

    def __init__(self, config: DifyConfig) -> None:
        self.config = config
