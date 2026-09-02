import re

import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.sharepoint.read import read_bytes
from mirage.core.sharepoint.resolve import _drive_cache, _site_cache
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_STALE_DRIVE_ID = "b!driveOLD"
_SITES_RE = re.compile(r".*/sites\?.*")
_DRIVES_RE = re.compile(r".*/sites/.*/drives.*")


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
    _seed_caches()
    yield
    _clear_caches()


@pytest.mark.asyncio
async def test_read_returns_content():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.txt:/content"
    with aioresponses() as m:
        m.get(url, body=b"file content")
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/report.txt", "/sp"),
                        virtual="/sp/Engineering/Documents/report.txt",
                        directory="/sp/Engineering/Documents/report.txt")
        data = await read_bytes(_accessor(), path)
    assert data == b"file content"


@pytest.mark.asyncio
async def test_read_missing_raises_file_not_found():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/nope.txt:/content"
    with aioresponses() as m:
        m.get(url,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/nope.txt", "/sp"),
                        virtual="/sp/Engineering/Documents/nope.txt",
                        directory="/sp/Engineering/Documents/nope.txt")
        with pytest.raises(FileNotFoundError):
            await read_bytes(_accessor(), path)


@pytest.mark.asyncio
async def test_read_range():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/data.bin:/content"
    captured = {}

    def _cb(url, **kwargs):
        captured["range"] = kwargs["headers"].get("Range")
        return CallbackResult(body=b"llo", status=206)

    with aioresponses() as m:
        m.get(url, callback=_cb)
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/data.bin", "/sp"),
                        virtual="/sp/Engineering/Documents/data.bin",
                        directory="/sp/Engineering/Documents/data.bin")
        data = await read_bytes(_accessor(), path, offset=2, size=3)
    assert captured["range"] == "bytes=2-4"
    assert data == b"llo"


@pytest.mark.asyncio
async def test_read_under_a_fresh_index_relists_the_drive():
    # The dispatcher's fresh substitute empties the index, but the site
    # and drive ids are remembered on the resolver, not in the index.
    # After a delete-and-recreate the memo names a drive that is gone,
    # so a read that trusted it would answer ENOENT for a file that is
    # there. The marked store is what tells the read to relist.
    _drive_cache[(_SITE_ID, "Documents")] = _STALE_DRIVE_ID
    stale = f"{_BASE}/drives/{_STALE_DRIVE_ID}/root:/report.txt:/content"
    live = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.txt:/content"
    path = PathSpec(resource_path=mount_key(
        "/sp/Engineering/Documents/report.txt", "/sp"),
                    virtual="/sp/Engineering/Documents/report.txt",
                    directory="/sp/Engineering/Documents/report.txt")
    with aioresponses() as m:
        m.get(_SITES_RE,
              payload={
                  "value": [{
                      "id": _SITE_ID,
                      "displayName": "Engineering",
                      "name": "eng",
                  }]
              },
              repeat=True)
        m.get(_DRIVES_RE,
              payload={"value": [{
                  "id": _DRIVE_ID,
                  "name": "Documents",
              }]},
              repeat=True)
        m.get(stale,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        m.get(live, body=b"new content")
        data = await read_bytes(_accessor(),
                                path,
                                index=RAMIndexCacheStore(fresh=True))
    assert data == b"new content"


@pytest.mark.asyncio
async def test_read_without_a_fresh_index_still_reads_the_memo():
    # The relist is the fresh path's price, not everyone's: an ordinary
    # read answers from the memo and makes no namespace call at all.
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.txt:/content"
    path = PathSpec(resource_path=mount_key(
        "/sp/Engineering/Documents/report.txt", "/sp"),
                    virtual="/sp/Engineering/Documents/report.txt",
                    directory="/sp/Engineering/Documents/report.txt")
    with aioresponses() as m:
        m.get(url, body=b"file content")
        data = await read_bytes(_accessor(), path, index=RAMIndexCacheStore())
    assert data == b"file content"
