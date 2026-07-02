import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.create import create
from mirage.core.onedrive.exists import exists
from mirage.core.onedrive.mkdir import mkdir
from mirage.core.onedrive.rename import rename
from mirage.core.onedrive.rm import rm_r
from mirage.core.onedrive.rmdir import rmdir
from mirage.core.onedrive.unlink import unlink
from mirage.types import PathSpec


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


_BASE = "https://graph.microsoft.com/v1.0/me/drive"


@pytest.mark.asyncio
async def test_mkdir_posts_folder_to_parent_children():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=201, payload={"id": "F"})

    with aioresponses() as m:
        m.post(_BASE + "/root:/a:/children", callback=_cb)
        await mkdir(_accessor(), PathSpec.from_str_path("/a/b"))
    assert body["name"] == "b"
    assert "folder" in body


@pytest.mark.asyncio
async def test_create_puts_empty_content():
    captured = {}

    def _cb(url, **kwargs):
        captured["body"] = kwargs.get("data")
        return CallbackResult(status=201, payload={"id": "X"})

    with aioresponses() as m:
        m.put(_BASE + "/root:/a.txt:/content", callback=_cb)
        await create(_accessor(), PathSpec.from_str_path("/a.txt"))
    assert captured["body"] in (b"", None)


@pytest.mark.asyncio
async def test_unlink_deletes_item():
    with aioresponses() as m:
        m.delete(_BASE + "/root:/a.txt", status=204)
        await unlink(_accessor(), PathSpec.from_str_path("/a.txt"))


@pytest.mark.asyncio
async def test_rmdir_deletes_folder():
    with aioresponses() as m:
        m.delete(_BASE + "/root:/docs", status=204)
        await rmdir(_accessor(), PathSpec.from_str_path("/docs"))


@pytest.mark.asyncio
async def test_rm_r_deletes_tree():
    with aioresponses() as m:
        m.delete(_BASE + "/root:/docs", status=204)
        await rm_r(_accessor(), PathSpec.from_str_path("/docs"))


@pytest.mark.asyncio
async def test_rename_patches_name():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=200, payload={"id": "X", "name": "b.txt"})

    with aioresponses() as m:
        m.patch(_BASE + "/root:/a.txt", callback=_cb)
        await rename(_accessor(), PathSpec.from_str_path("/a.txt"),
                     PathSpec.from_str_path("/b.txt"))
    assert body["name"] == "b.txt"


@pytest.mark.asyncio
async def test_exists_true_and_false():
    with aioresponses() as m:
        m.get(_BASE + "/root:/a.txt",
              payload={
                  "id": "X",
                  "name": "a.txt",
                  "file": {}
              })
        assert await exists(_accessor(),
                            PathSpec.from_str_path("/a.txt")) is True
    with aioresponses() as m:
        m.get(_BASE + "/root:/missing.txt",
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        assert await exists(_accessor(),
                            PathSpec.from_str_path("/missing.txt")) is False
