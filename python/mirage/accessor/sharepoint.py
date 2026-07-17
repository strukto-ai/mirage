from mirage.accessor.base import Accessor
from mirage.core.msgraph.config import MsGraphConfig


class SharePointConfig(MsGraphConfig):
    site_filter: str | None = None
    site: str | None = None
    drive: str | None = None


class SharePointAccessor(Accessor):

    def __init__(self, config: SharePointConfig) -> None:
        self.config = config
