import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.commands.builtin.find_eval import Name, Not, Or
from mirage.core.onedrive.find import find
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
async def test_find_returns_files_and_folders():
    with aioresponses() as m:
        _tree(m)
        out = await find(_accessor(), PathSpec.from_str_path("/"))
    assert out == ["/", "/a.txt", "/sub", "/sub/b.txt"]


@pytest.mark.asyncio
async def test_find_type_file_excludes_folders():
    with aioresponses() as m:
        _tree(m)
        out = await find(_accessor(), PathSpec.from_str_path("/"), type="file")
    assert out == ["/a.txt", "/sub/b.txt"]


@pytest.mark.asyncio
async def test_find_name_glob():
    with aioresponses() as m:
        _tree(m)
        out = await find(_accessor(), PathSpec.from_str_path("/"), name="b.*")
    assert out == ["/sub/b.txt"]


@pytest.mark.asyncio
async def test_find_honors_not_tree():
    tree = Not(Name("a.txt"))
    with aioresponses() as m:
        _tree(m)
        out = await find(_accessor(), PathSpec.from_str_path("/"), tree=tree)
    assert "/a.txt" not in out
    assert "/sub/b.txt" in out


@pytest.mark.asyncio
async def test_find_honors_or_tree():
    tree = Or([Name("a.txt"), Name("b.txt")])
    with aioresponses() as m:
        _tree(m)
        out = await find(_accessor(), PathSpec.from_str_path("/"), tree=tree)
    assert out == ["/a.txt", "/sub/b.txt"]


@pytest.mark.asyncio
async def test_find_empty_matches_childless_folder():
    with aioresponses() as m:
        m.get(_BASE + "/root/children",
              payload={
                  "value": [
                      {
                          "id": "1",
                          "name": "a.txt",
                          "size": 3,
                          "file": {}
                      },
                      {
                          "id": "2",
                          "name": "hollow",
                          "folder": {
                              "childCount": 0
                          }
                      },
                      {
                          "id": "3",
                          "name": "full",
                          "folder": {
                              "childCount": 1
                          }
                      },
                  ]
              })
        m.get(_BASE + "/root:/hollow:/children", payload={"value": []})
        m.get(_BASE + "/root:/full:/children",
              payload={
                  "value": [{
                      "id": "4",
                      "name": "c.txt",
                      "size": 1,
                      "file": {}
                  }]
              })
        out = await find(_accessor(),
                         PathSpec.from_str_path("/"),
                         type="d",
                         empty=True)
    assert out == ["/hollow"]


@pytest.mark.asyncio
async def test_find_empty_folder_emits_start_path():
    with aioresponses() as m:
        m.get(_BASE + "/root:/empty:/children", payload={"value": []})
        m.get(_BASE + "/root:/empty",
              payload={
                  "id": "9",
                  "name": "empty",
                  "folder": {
                      "childCount": 0
                  }
              })
        out = await find(_accessor(),
                         PathSpec.from_str_path("/empty"),
                         type="d")
    assert out == ["/empty"]
