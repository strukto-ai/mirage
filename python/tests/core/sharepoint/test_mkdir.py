import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint._client import GraphError
from mirage.core.sharepoint._resolver import _drive_cache, _site_cache
from mirage.core.sharepoint.mkdir import mkdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_DRIVE = f"{_BASE}/drives/{_DRIVE_ID}"


def _accessor() -> SharePointAccessor:
    return SharePointAccessor(SharePointConfig(access_token="tok"))


def _spec(rel: str) -> PathSpec:
    virtual = f"/sp/Engineering/Documents/{rel}"
    return PathSpec(resource_path=mount_key(virtual, "/sp"),
                    virtual=virtual,
                    directory=virtual)


@pytest.fixture(autouse=True)
def _seeded_caches():
    _site_cache.clear()
    _drive_cache.clear()
    _site_cache["Engineering"] = _SITE_ID
    _drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    yield
    _site_cache.clear()
    _drive_cache.clear()


@pytest.mark.asyncio
async def test_mkdir_posts_folder_with_fail_behavior():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=201, payload={"id": "1"})

    with aioresponses() as m:
        m.post(_DRIVE + "/root/children", callback=_cb)
        await mkdir(_accessor(), _spec("new"))
    assert body["name"] == "new"
    assert body["folder"] == {}
    assert body["@microsoft.graph.conflictBehavior"] == "fail"


@pytest.mark.asyncio
async def test_mkdir_tolerates_existing_item():
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root/children",
            status=409,
            payload={"error": {
                "code": "nameAlreadyExists",
                "message": "x"
            }})
        await mkdir(_accessor(), _spec("new"))


@pytest.mark.asyncio
async def test_mkdir_raises_on_other_errors():
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root/children",
            status=507,
            payload={"error": {
                "code": "insufficientStorage",
                "message": "x"
            }})
        with pytest.raises(GraphError):
            await mkdir(_accessor(), _spec("new"))


@pytest.mark.asyncio
async def test_mkdir_parents_creates_each_level():
    posts: list[str] = []

    def _cb(url, **kwargs):
        posts.append(str(url))
        return CallbackResult(status=201, payload={"id": "1"})

    with aioresponses() as m:
        m.post(_DRIVE + "/root/children", callback=_cb)
        m.post(_DRIVE + "/root:/a:/children", callback=_cb)
        await mkdir(_accessor(), _spec("a/b"), parents=True)
    assert posts == [
        _DRIVE + "/root/children",
        _DRIVE + "/root:/a:/children",
    ]
