import re

import pytest
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.sharepoint._resolver import _drive_cache, _site_cache
from mirage.core.sharepoint.readdir import readdir
from mirage.types import PathSpec

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"

_SITES_RE = re.compile(r".*/sites\??.*")
_DRIVES_RE = re.compile(r".*/sites/.*/drives\??.*")


def _accessor() -> SharePointAccessor:
    return SharePointAccessor(SharePointConfig(access_token="tok"))


def _seed_caches():
    _site_cache["Engineering"] = _SITE_ID
    _drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID


def _clear_caches():
    _site_cache.clear()
    _drive_cache.clear()


@pytest.fixture(autouse=True)
def _reset_caches():
    _clear_caches()
    yield
    _clear_caches()


@pytest.mark.asyncio
async def test_readdir_root_lists_sites():
    index = RAMIndexCacheStore()
    with aioresponses() as m:
        m.get(_SITES_RE,
              payload={
                  "value": [
                      {
                          "id": "s1",
                          "displayName": "Engineering",
                          "name": "eng"
                      },
                      {
                          "id": "s2",
                          "displayName": "Marketing",
                          "name": "mkt"
                      },
                  ]
              })
        path = PathSpec(original="/sp/", directory="/sp/", prefix="/sp")
        names = await readdir(_accessor(), path, index)
    assert "/sp/Engineering" in names
    assert "/sp/Marketing" in names


@pytest.mark.asyncio
async def test_readdir_site_lists_drives():
    _site_cache["Engineering"] = _SITE_ID
    index = RAMIndexCacheStore()
    with aioresponses() as m:
        m.get(_DRIVES_RE,
              payload={
                  "value": [
                      {
                          "id": _DRIVE_ID,
                          "name": "Documents"
                      },
                      {
                          "id": "b!other",
                          "name": "Archives"
                      },
                  ]
              })
        path = PathSpec(original="/sp/Engineering",
                        directory="/sp/Engineering",
                        prefix="/sp")
        names = await readdir(_accessor(), path, index)
    assert "/sp/Engineering/Archives" in names
    assert "/sp/Engineering/Documents" in names


@pytest.mark.asyncio
async def test_readdir_drive_root_lists_children():
    _seed_caches()
    index = RAMIndexCacheStore()
    with aioresponses() as m:
        m.get(f"{_BASE}/drives/{_DRIVE_ID}/root/children",
              payload={
                  "value": [
                      {
                          "id": "1",
                          "name": "readme.md",
                          "size": 100,
                          "file": {},
                          "lastModifiedDateTime": "2026-06-01T10:00:00Z"
                      },
                      {
                          "id": "2",
                          "name": "src",
                          "size": 0,
                          "folder": {
                              "childCount": 5
                          },
                          "lastModifiedDateTime": "2026-06-02T10:00:00Z"
                      },
                  ]
              })
        path = PathSpec(original="/sp/Engineering/Documents",
                        directory="/sp/Engineering/Documents",
                        prefix="/sp")
        names = await readdir(_accessor(), path, index)
    assert "/sp/Engineering/Documents/readme.md" in names
    assert "/sp/Engineering/Documents/src" in names


@pytest.mark.asyncio
async def test_readdir_populates_index_with_metadata():
    _seed_caches()
    index = RAMIndexCacheStore()
    with aioresponses() as m:
        m.get(f"{_BASE}/drives/{_DRIVE_ID}/root/children",
              payload={
                  "value": [
                      {
                          "id": "1",
                          "name": "a.txt",
                          "size": 42,
                          "file": {},
                          "lastModifiedDateTime": "2026-06-15T08:00:00Z"
                      },
                  ]
              })
        path = PathSpec(original="/sp/Engineering/Documents",
                        directory="/sp/Engineering/Documents",
                        prefix="/sp")
        await readdir(_accessor(), path, index)
    lookup = await index.get("/sp/Engineering/Documents/a.txt")
    assert lookup.entry is not None
    assert lookup.entry.size == 42
    assert lookup.entry.remote_time == "2026-06-15T08:00:00Z"


@pytest.mark.asyncio
async def test_readdir_subfolder():
    _seed_caches()
    index = RAMIndexCacheStore()
    with aioresponses() as m:
        m.get(f"{_BASE}/drives/{_DRIVE_ID}/root:/src:/children",
              payload={
                  "value": [
                      {
                          "id": "3",
                          "name": "main.py",
                          "size": 200,
                          "file": {}
                      },
                  ]
              })
        path = PathSpec(original="/sp/Engineering/Documents/src",
                        directory="/sp/Engineering/Documents/src",
                        prefix="/sp")
        names = await readdir(_accessor(), path, index)
    assert "/sp/Engineering/Documents/src/main.py" in names


@pytest.mark.asyncio
async def test_readdir_cache_hit():
    _seed_caches()
    index = RAMIndexCacheStore()
    with aioresponses() as m:
        m.get(f"{_BASE}/drives/{_DRIVE_ID}/root/children",
              payload={
                  "value": [
                      {
                          "id": "1",
                          "name": "cached.txt",
                          "size": 10,
                          "file": {}
                      },
                  ]
              })
        path = PathSpec(original="/sp/Engineering/Documents",
                        directory="/sp/Engineering/Documents",
                        prefix="/sp")
        await readdir(_accessor(), path, index)
        # Second call should hit cache, no extra HTTP call
        names = await readdir(_accessor(), path, index)
    assert "/sp/Engineering/Documents/cached.txt" in names
