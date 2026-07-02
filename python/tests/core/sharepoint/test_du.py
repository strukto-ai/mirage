import pytest
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint._resolver import _drive_cache, _site_cache
from mirage.core.sharepoint.du import du, du_all
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"


def _accessor() -> SharePointAccessor:
    return SharePointAccessor(SharePointConfig(access_token="tok"))


def _seed_caches():
    _site_cache["Engineering"] = _SITE_ID
    _drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID


@pytest.fixture(autouse=True)
def _reset_caches():
    _site_cache.clear()
    _drive_cache.clear()
    yield
    _site_cache.clear()
    _drive_cache.clear()


def _file_path() -> PathSpec:
    return PathSpec(resource_path=mount_key("/sp/Engineering/Documents/a.txt",
                                            "/sp"),
                    virtual="/sp/Engineering/Documents/a.txt",
                    directory="/sp/Engineering/Documents")


@pytest.mark.asyncio
async def test_du_of_file_returns_its_own_size():
    _seed_caches()
    with aioresponses() as m:
        m.get(f"{_BASE}/drives/{_DRIVE_ID}/root:/a.txt",
              payload={
                  "id": "1",
                  "name": "a.txt",
                  "size": 3,
                  "file": {}
              })
        total = await du(_accessor(), _file_path())
    assert total == 3


@pytest.mark.asyncio
async def test_du_all_of_file_is_empty():
    _seed_caches()
    with aioresponses() as m:
        m.get(f"{_BASE}/drives/{_DRIVE_ID}/root:/a.txt",
              payload={
                  "id": "1",
                  "name": "a.txt",
                  "size": 3,
                  "file": {}
              })
        rows = await du_all(_accessor(), _file_path())
    assert rows == []
