import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive._client import GraphError
from mirage.core.onedrive.mkdir import mkdir
from mirage.types import PathSpec

_BASE = "https://graph.microsoft.com/v1.0/me/drive"


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


@pytest.mark.asyncio
async def test_mkdir_posts_folder_with_fail_behavior():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=201, payload={"id": "1"})

    with aioresponses() as m:
        m.post(_BASE + "/root:/parent:/children", callback=_cb)
        await mkdir(_accessor(), PathSpec.from_str_path("/parent/new"))
    assert body["name"] == "new"
    assert body["folder"] == {}
    assert body["@microsoft.graph.conflictBehavior"] == "fail"


@pytest.mark.asyncio
async def test_mkdir_tolerates_existing_item():
    with aioresponses() as m:
        m.post(
            _BASE + "/root:/parent:/children",
            status=409,
            payload={"error": {
                "code": "nameAlreadyExists",
                "message": "x"
            }})
        await mkdir(_accessor(), PathSpec.from_str_path("/parent/new"))


@pytest.mark.asyncio
async def test_mkdir_raises_on_other_errors():
    with aioresponses() as m:
        m.post(
            _BASE + "/root:/parent:/children",
            status=507,
            payload={"error": {
                "code": "insufficientStorage",
                "message": "x"
            }})
        with pytest.raises(GraphError):
            await mkdir(_accessor(), PathSpec.from_str_path("/parent/new"))


@pytest.mark.asyncio
async def test_mkdir_parents_creates_each_level():
    posts: list[str] = []

    def _cb(url, **kwargs):
        posts.append(str(url))
        return CallbackResult(status=201, payload={"id": "1"})

    with aioresponses() as m:
        m.post(_BASE + "/root/children", callback=_cb)
        m.post(_BASE + "/root:/a:/children", callback=_cb)
        await mkdir(_accessor(), PathSpec.from_str_path("/a/b"), parents=True)
    assert posts == [
        _BASE + "/root/children",
        _BASE + "/root:/a:/children",
    ]
