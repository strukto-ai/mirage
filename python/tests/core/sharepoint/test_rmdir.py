import errno

import pytest
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.rmdir import rmdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_DRIVE = f"{_BASE}/drives/{_DRIVE_ID}"

_FILE = {"id": "c1", "name": "a.txt", "size": 1}
_FOLDER = {"id": "c2", "name": "sub", "folder": {"childCount": 0}}
# The emptiness probe is one bounded page, not a full listing walk, so the
# query is part of the URL the stub has to match; a regression to
# `graph_list` stops matching it.
_PROBE = "?$top=1&$select=id"


def _accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


def _spec(rel: str) -> PathSpec:
    virtual = f"/sp/Engineering/Documents/{rel}"
    return PathSpec(resource_path=mount_key(virtual, "/sp"),
                    virtual=virtual,
                    directory=virtual)


@pytest.mark.asyncio
async def test_rmdir_deletes_an_empty_folder():
    with aioresponses() as m:
        m.get(_DRIVE + "/root:/dir:/children" + _PROBE, payload={"value": []})
        m.delete(_DRIVE + "/root:/dir", status=204)
        await rmdir(_accessor(), _spec("dir"))


@pytest.mark.asyncio
async def test_rmdir_refuses_a_folder_holding_a_file():
    with aioresponses() as m:
        m.get(_DRIVE + "/root:/dir:/children" + _PROBE,
              payload={"value": [_FILE]})
        with pytest.raises(OSError) as excinfo:
            await rmdir(_accessor(), _spec("dir"))
        sent = [key[0] for key in m.requests]
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert "DELETE" not in sent


@pytest.mark.asyncio
async def test_rmdir_refuses_a_folder_holding_a_subfolder():
    with aioresponses() as m:
        m.get(_DRIVE + "/root:/dir:/children" + _PROBE,
              payload={"value": [_FOLDER]})
        with pytest.raises(OSError) as excinfo:
            await rmdir(_accessor(), _spec("dir"))
    assert excinfo.value.errno == errno.ENOTEMPTY
