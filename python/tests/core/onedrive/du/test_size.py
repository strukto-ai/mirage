import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.du import size
from mirage.types import PathSpec


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


_BASE = "https://graph.microsoft.com/v1.0/me/drive"


def _tree(m):
    m.get(_BASE + "/root/children",
          payload={
              "value": [
                  {
                      "id": "1",
                      "name": "a.txt",
                      "size": 3,
                      "lastModifiedDateTime": "2026-07-15T12:00:00Z",
                      "file": {}
                  },
                  {
                      "id": "2",
                      "name": "sub",
                      "lastModifiedDateTime": "2026-07-14T12:00:00Z",
                      "folder": {
                          "childCount": 1
                      }
                  },
              ]
          })
    m.get(_BASE + "/root:/sub:/children",
          payload={
              "value": [{
                  "id": "3",
                  "name": "b.txt",
                  "size": 5,
                  "lastModifiedDateTime": "2026-07-13T12:00:00Z",
                  "file": {}
              }]
          })


def _root(m):
    m.get(_BASE + "/root",
          payload={
              "id": "root",
              "name": "root",
              "lastModifiedDateTime": "2026-07-14T12:00:00Z",
              "folder": {
                  "childCount": 2
              }
          })


@pytest.mark.asyncio
async def test_size_sums_all_files_recursively():
    with aioresponses() as m:
        _root(m)
        _tree(m)
        total = await size(_accessor(), PathSpec.from_str_path("/"))
    assert total == 8


@pytest.mark.asyncio
async def test_size_of_file_returns_its_own_size():
    with aioresponses() as m:
        m.get(_BASE + "/root:/a.txt",
              payload={
                  "id": "1",
                  "name": "a.txt",
                  "size": 3,
                  "file": {}
              })
        total = await size(_accessor(), PathSpec.from_str_path("/a.txt"))
    assert total == 3
