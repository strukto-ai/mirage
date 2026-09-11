import pytest
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.du import size
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"


def _accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


def _file_path() -> PathSpec:
    return PathSpec(resource_path=mount_key("/sp/Engineering/Documents/a.txt",
                                            "/sp"),
                    virtual="/sp/Engineering/Documents/a.txt",
                    directory="/sp/Engineering/Documents")


@pytest.mark.asyncio
async def test_size_of_file_returns_its_own_size():
    with aioresponses() as m:
        m.get(f"{_BASE}/drives/{_DRIVE_ID}/root:/a.txt",
              payload={
                  "id": "1",
                  "name": "a.txt",
                  "size": 3,
                  "file": {}
              })
        total = await size(_accessor(), _file_path())
    assert total == 3
