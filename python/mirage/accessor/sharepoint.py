import aiohttp
from pydantic import field_validator

from mirage.accessor.base import SessionAccessor
from mirage.core.msgraph.config import MsGraphConfig
from mirage.utils import key_prefix as kp


class SharePointConfig(MsGraphConfig):
    site_filter: str | None = None
    site: str | None = None
    drive: str | None = None
    key_prefix: str | None = None

    @field_validator("key_prefix")
    @classmethod
    def normalize_key_prefix(cls, value: str | None) -> str | None:
        normalized = kp.normalize(value).rstrip("/")
        if any(part == ".." for part in normalized.split("/")):
            raise ValueError("key_prefix must not contain '..' segments")
        return normalized or None


class SharePointAccessor(SessionAccessor):

    def __init__(self, config: SharePointConfig) -> None:
        super().__init__(timeout=aiohttp.ClientTimeout(total=config.timeout))
        self.config = config
