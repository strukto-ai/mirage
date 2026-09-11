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
        # Name -> id lookups for the two namespace levels above a drive item,
        # so resolving a path does not call /sites and /drives on every op.
        #
        # They live on the accessor, not the module, on purpose: one accessor
        # is one mount is one tenant, and a site name is only unique within a
        # tenant. A process-wide dict handed tenant B the site id tenant A had
        # cached under the same name.
        #
        # Two dicts because the keys are different shapes. A site is found by
        # name alone; a drive name is only unique within its site, so its key
        # must carry the site id.
        #
        #   site_cache["Engineering"] = "contoso.sharepoint.com,<site>,<web>"
        #   site_cache["eng"] = <same id>  (internal name, from site_entries)
        #   drive_cache[(<that site id>, "Documents")] = "b!driveXYZ"
        #
        # Entries are never evicted: a site or drive deleted and recreated
        # under the same name keeps answering the old id for this accessor's
        # lifetime.
        self.site_cache: dict[str, str] = {}
        self.drive_cache: dict[tuple[str, str], str] = {}
