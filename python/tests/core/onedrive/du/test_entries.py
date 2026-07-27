import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.du import entries
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
async def test_entries_lists_files_with_total():
    with aioresponses() as m:
        _root(m)
        _tree(m)
        rows, total = await entries(_accessor(), PathSpec.from_str_path("/"))
    assert ("/a.txt", 3) in rows
    assert ("/sub/b.txt", 5) in rows
    assert total == 8


@pytest.mark.asyncio
async def test_entries_of_file_is_empty():
    with aioresponses() as m:
        m.get(_BASE + "/root:/a.txt",
              payload={
                  "id": "1",
                  "name": "a.txt",
                  "size": 3,
                  "file": {}
              })
        rows, total = await entries(_accessor(),
                                    PathSpec.from_str_path("/a.txt"))
    assert rows == []
    assert total == 3
