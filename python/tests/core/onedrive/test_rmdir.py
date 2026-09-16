import errno

import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.rmdir import rmdir
from mirage.types import PathSpec

_BASE = "https://graph.microsoft.com/v1.0/me/drive"

_FILE = {"id": "c1", "name": "a.txt", "size": 1}
_FOLDER = {"id": "c2", "name": "sub", "folder": {"childCount": 0}}
# The emptiness probe is one bounded page, not a full listing walk, so the
# query is part of the URL the stub has to match; a regression to
# `graph_list` stops matching it.
_PROBE = "?$top=1&$select=id"


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


@pytest.mark.asyncio
async def test_rmdir_deletes_an_empty_folder():
    with aioresponses() as m:
        m.get(_BASE + "/root:/dir:/children" + _PROBE, payload={"value": []})
        m.delete(_BASE + "/root:/dir", status=204)
        await rmdir(_accessor(), PathSpec.from_str_path("/dir"))
        assert ("DELETE", URL(_BASE + "/root:/dir")) in m.requests


@pytest.mark.asyncio
async def test_rmdir_refuses_a_folder_holding_a_file():
    with aioresponses() as m:
        m.get(_BASE + "/root:/dir:/children" + _PROBE,
              payload={"value": [_FILE]})
        with pytest.raises(OSError) as excinfo:
            await rmdir(_accessor(), PathSpec.from_str_path("/dir"))
    assert excinfo.value.errno == errno.ENOTEMPTY


@pytest.mark.asyncio
async def test_rmdir_refuses_a_folder_holding_a_subfolder():
    with aioresponses() as m:
        m.get(_BASE + "/root:/dir:/children" + _PROBE,
              payload={"value": [_FOLDER]})
        with pytest.raises(OSError) as excinfo:
            await rmdir(_accessor(), PathSpec.from_str_path("/dir"))
    assert excinfo.value.errno == errno.ENOTEMPTY


@pytest.mark.asyncio
async def test_rmdir_sends_no_delete_when_it_refuses():
    with aioresponses() as m:
        m.get(_BASE + "/root:/dir:/children" + _PROBE,
              payload={"value": [_FILE]})
        with pytest.raises(OSError):
            await rmdir(_accessor(), PathSpec.from_str_path("/dir"))
        sent = [key[0] for key in m.requests]
    assert "DELETE" not in sent
