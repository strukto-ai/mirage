import pytest
from aioresponses import CallbackResult, aioresponses
from yarl import URL

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.msgraph.client import GraphError
from mirage.core.sharepoint.mkdir import mkdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_DRIVE = f"{_BASE}/drives/{_DRIVE_ID}"


def _accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


def _spec(rel: str) -> PathSpec:
    virtual = f"/sp/Engineering/Documents/{rel}"
    return PathSpec(
        vfs_path=mount_key(virtual, "/sp"), virtual=virtual, directory=virtual
    )


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
async def test_mkdir_parents_tolerates_an_existing_folder():
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root/children",
            status=409,
            payload={"error": {"code": "nameAlreadyExists", "message": "x"}},
        )
        m.get(_DRIVE + "/root:/new", payload={"id": "1", "folder": {}})
        await mkdir(_accessor(), _spec("new"), parents=True)
        assert len(m.requests[("POST", URL(_DRIVE + "/root/children"))]) == 1


@pytest.mark.asyncio
async def test_mkdir_refuses_a_folder_made_after_the_lookup():
    """A folder another client made after the lookup ran still 409s."""
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root/children",
            status=409,
            payload={"error": {"code": "nameAlreadyExists", "message": "x"}},
        )
        m.get(_DRIVE + "/root:/new", payload={"id": "1", "folder": {}})
        with pytest.raises(FileExistsError):
            await mkdir(_accessor(), _spec("new"))


@pytest.mark.asyncio
async def test_mkdir_refuses_a_name_a_file_holds():
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root/children",
            status=409,
            payload={"error": {"code": "nameAlreadyExists", "message": "x"}},
        )
        m.get(_DRIVE + "/root:/new", payload={"id": "1", "file": {}})
        with pytest.raises(FileExistsError):
            await mkdir(_accessor(), _spec("new"))


@pytest.mark.asyncio
async def test_mkdir_under_a_file_is_not_a_directory():
    with aioresponses() as m:
        m.post(_DRIVE + "/root:/f:/children", status=404, payload=_NOT_FOUND)
        m.get(_DRIVE + "/root:/f", payload={"id": "1", "file": {}})
        with pytest.raises(NotADirectoryError):
            await mkdir(_accessor(), _spec("f/new"))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("rel", "error", "named"),
    [
        ("f/x/y", NotADirectoryError, "/sp/Engineering/Documents/f"),
        ("f", FileExistsError, "/sp/Engineering/Documents/f"),
    ],
)
async def test_mkdir_parents_names_the_file_it_stops_at(rel, error, named):
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root/children",
            status=409,
            payload={"error": {"code": "nameAlreadyExists", "message": "x"}},
        )
        m.get(_DRIVE + "/root:/f", payload={"id": "1", "file": {}})
        with pytest.raises(error, match=f"'{named}'$"):
            await mkdir(_accessor(), _spec(rel), parents=True)


@pytest.mark.asyncio
async def test_mkdir_raises_on_other_errors():
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root/children",
            status=507,
            payload={"error": {"code": "insufficientStorage", "message": "x"}},
        )
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


_NOT_FOUND = {"error": {"code": "itemNotFound", "message": "x"}}


def _scoped_accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(
        SharePointConfig(
            access_token="tok",
            site="Engineering",
            drive="Documents",
            key_prefix="team/root",
        )
    )
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


def _scoped_spec(rel: str) -> PathSpec:
    virtual = f"/sp/{rel}"
    return PathSpec(
        vfs_path=mount_key(virtual, "/sp"), virtual=virtual, directory=virtual
    )


def _recording(posts: list[str], status: int = 201):
    def _cb(url, **kwargs):
        posts.append(f"{status} {url}")
        payload = {"id": "1"} if status < 400 else _NOT_FOUND
        return CallbackResult(status=status, payload=payload)

    return _cb


@pytest.mark.asyncio
async def test_mkdir_creates_a_missing_mount_root_then_retries():
    posts: list[str] = []
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root:/team/root:/children",
            callback=_recording(posts, 404),
        )
        m.get(_DRIVE + "/root:/team/root", status=404, payload=_NOT_FOUND)
        m.post(_DRIVE + "/root/children", callback=_recording(posts))
        m.post(_DRIVE + "/root:/team:/children", callback=_recording(posts))
        m.post(
            _DRIVE + "/root:/team/root:/children", callback=_recording(posts)
        )
        await mkdir(_scoped_accessor(), _scoped_spec("lt"))
    assert posts == [
        "404 " + _DRIVE + "/root:/team/root:/children",
        "201 " + _DRIVE + "/root/children",
        "201 " + _DRIVE + "/root:/team:/children",
        "201 " + _DRIVE + "/root:/team/root:/children",
    ]


@pytest.mark.asyncio
async def test_mkdir_does_not_retry_a_404_below_the_mount_root():
    posts: list[str] = []
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root:/team/root/a:/children",
            callback=_recording(posts, 404),
        )
        m.get(_DRIVE + "/root:/team/root/a", status=404, payload=_NOT_FOUND)
        with pytest.raises(FileNotFoundError):
            await mkdir(_scoped_accessor(), _scoped_spec("a/b"))
    assert posts == ["404 " + _DRIVE + "/root:/team/root/a:/children"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("parents", "named"), [(True, "/sp"), (False, "/sp/lt")]
)
async def test_mkdir_names_a_file_in_the_hidden_prefix_as_the_root(
    parents, named
):
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root:/team/root:/children",
            status=404,
            payload=_NOT_FOUND,
        )
        m.get(_DRIVE + "/root:/team/root", status=404, payload=_NOT_FOUND)
        m.post(
            _DRIVE + "/root/children",
            status=409,
            payload={"error": {"code": "nameAlreadyExists", "message": "x"}},
        )
        m.get(_DRIVE + "/root:/team", payload={"id": "1", "file": {}})
        with pytest.raises(NotADirectoryError, match=f"'{named}'$"):
            await mkdir(
                _scoped_accessor(), _scoped_spec("lt"), parents=parents
            )
