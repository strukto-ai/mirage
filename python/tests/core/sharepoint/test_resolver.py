import re

import pytest
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint._resolver import _drive_cache, _site_cache, resolve
from mirage.types import PathSpec

_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_SITES_RE = re.compile(r".*/sites\??.*")


def _accessor() -> SharePointAccessor:
    return SharePointAccessor(SharePointConfig(access_token="tok"))


def _clear_caches():
    _site_cache.clear()
    _drive_cache.clear()


@pytest.fixture(autouse=True)
def _reset_caches():
    _clear_caches()
    yield
    _clear_caches()


@pytest.mark.asyncio
async def test_resolve_root():
    path = PathSpec(original="/sp/", directory="/sp/", prefix="/sp")
    result = await resolve(_accessor(), path)
    assert result.level == "root"


@pytest.mark.asyncio
async def test_resolve_site():
    _site_cache["Engineering"] = _SITE_ID
    path = PathSpec(original="/sp/Engineering",
                    directory="/sp/Engineering",
                    prefix="/sp")
    result = await resolve(_accessor(), path)
    assert result.level == "site"
    assert result.site_id == _SITE_ID


@pytest.mark.asyncio
async def test_resolve_drive():
    _site_cache["Engineering"] = _SITE_ID
    _drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    path = PathSpec(original="/sp/Engineering/Documents",
                    directory="/sp/Engineering/Documents",
                    prefix="/sp")
    result = await resolve(_accessor(), path)
    assert result.level == "drive"
    assert result.drive_id == _DRIVE_ID


@pytest.mark.asyncio
async def test_resolve_item():
    _site_cache["Engineering"] = _SITE_ID
    _drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    path = PathSpec(original="/sp/Engineering/Documents/sub/file.txt",
                    directory="/sp/Engineering/Documents/sub/file.txt",
                    prefix="/sp")
    result = await resolve(_accessor(), path)
    assert result.level == "item"
    assert result.drive_id == _DRIVE_ID
    assert result.item_path == "sub/file.txt"


@pytest.mark.asyncio
async def test_resolve_unknown_site():
    with aioresponses() as m:
        m.get(_SITES_RE,
              payload={
                  "value": [
                      {
                          "id": "other-id",
                          "displayName": "Other",
                          "name": "other"
                      },
                  ]
              })
        path = PathSpec(original="/sp/NoSuchSite",
                        directory="/sp/NoSuchSite",
                        prefix="/sp")
        result = await resolve(_accessor(), path)
    assert result.level == "site"
    assert result.site_id is None
