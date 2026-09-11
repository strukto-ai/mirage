import re

import pytest
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.resolve import resolve, site_entries
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_SITES_RE = re.compile(r".*/sites\??.*")


def _accessor() -> SharePointAccessor:
    return SharePointAccessor(SharePointConfig(access_token="tok"))


@pytest.mark.asyncio
async def test_resolve_root():
    path = PathSpec(resource_path=mount_key("/sp/", "/sp"),
                    virtual="/sp/",
                    directory="/sp/")
    result = await resolve(_accessor(), path)
    assert result.level == "root"


@pytest.mark.asyncio
async def test_resolve_site():
    accessor = _accessor()
    accessor.site_cache["Engineering"] = _SITE_ID
    path = PathSpec(resource_path=mount_key("/sp/Engineering", "/sp"),
                    virtual="/sp/Engineering",
                    directory="/sp/Engineering")
    result = await resolve(accessor, path)
    assert result.level == "site"
    assert result.site_id == _SITE_ID


@pytest.mark.asyncio
async def test_resolve_drive():
    accessor = _accessor()
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    path = PathSpec(resource_path=mount_key("/sp/Engineering/Documents",
                                            "/sp"),
                    virtual="/sp/Engineering/Documents",
                    directory="/sp/Engineering/Documents")
    result = await resolve(accessor, path)
    assert result.level == "drive"
    assert result.drive_id == _DRIVE_ID


@pytest.mark.asyncio
async def test_resolve_item():
    accessor = _accessor()
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    path = PathSpec(resource_path=mount_key(
        "/sp/Engineering/Documents/sub/file.txt", "/sp"),
                    virtual="/sp/Engineering/Documents/sub/file.txt",
                    directory="/sp/Engineering/Documents/sub/file.txt")
    result = await resolve(accessor, path)
    assert result.level == "item"
    assert result.drive_id == _DRIVE_ID
    assert result.item_path == "sub/file.txt"


@pytest.mark.asyncio
async def test_resolve_unknown_site():
    with aioresponses() as m:
        m.get(_SITES_RE,
              payload={
                  "value": [
                      {
                          "id": "other-id",
                          "displayName": "Other",
                          "name": "other"
                      },
                  ]
              })
        path = PathSpec(resource_path=mount_key("/sp/NoSuchSite", "/sp"),
                        virtual="/sp/NoSuchSite",
                        directory="/sp/NoSuchSite")
        result = await resolve(_accessor(), path)
    assert result.level == "site"
    assert result.site_id is None


@pytest.mark.asyncio
async def test_site_entries_caches_display_name_and_name():
    accessor = _accessor()
    with aioresponses() as m:
        m.get(_SITES_RE,
              payload={
                  "value": [{
                      "id": _SITE_ID,
                      "displayName": "Engineering",
                      "name": "eng"
                  }]
              })
        entries = await site_entries(accessor)
    assert entries == [("Engineering", _SITE_ID)]
    assert accessor.site_cache["Engineering"] == _SITE_ID
    assert accessor.site_cache["eng"] == _SITE_ID


def _scoped_accessor() -> SharePointAccessor:
    return SharePointAccessor(
        SharePointConfig(access_token="tok",
                         site="Engineering",
                         drive="Documents"))


def _prefix_scoped_accessor() -> SharePointAccessor:
    return SharePointAccessor(
        SharePointConfig(access_token="tok",
                         site="Engineering",
                         drive="Documents",
                         key_prefix="/team/reports/"))


def _seed_scoped(accessor: SharePointAccessor) -> None:
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID


def _spec(virtual: str) -> PathSpec:
    return PathSpec(resource_path=mount_key(virtual, "/sp"),
                    virtual=virtual,
                    directory=virtual)


@pytest.mark.asyncio
async def test_scoped_resolve_root_is_drive_level():
    accessor = _scoped_accessor()
    _seed_scoped(accessor)
    result = await resolve(accessor, _spec("/sp/"))
    assert result.level == "drive"
    assert result.drive_id == _DRIVE_ID
    assert result.item_path is None


@pytest.mark.asyncio
async def test_scoped_resolve_path_is_drive_relative_item():
    accessor = _scoped_accessor()
    _seed_scoped(accessor)
    result = await resolve(accessor, _spec("/sp/sub/a.txt"))
    assert result.level == "item"
    assert result.drive_id == _DRIVE_ID
    assert result.item_path == "sub/a.txt"


@pytest.mark.asyncio
async def test_prefix_scoped_resolve_root_is_prefix_item():
    accessor = _prefix_scoped_accessor()
    _seed_scoped(accessor)
    result = await resolve(accessor, _spec("/sp/"))
    assert result.level == "item"
    assert result.drive_id == _DRIVE_ID
    assert result.item_path == "team/reports"


@pytest.mark.asyncio
async def test_prefix_scoped_resolve_path_is_prefix_relative_item():
    accessor = _prefix_scoped_accessor()
    _seed_scoped(accessor)
    result = await resolve(accessor, _spec("/sp/sub/a.txt"))
    assert result.level == "item"
    assert result.drive_id == _DRIVE_ID
    assert result.item_path == "team/reports/sub/a.txt"


def test_prefix_scoped_config_rejects_parent_segments():
    with pytest.raises(ValueError, match="must not contain"):
        SharePointConfig(access_token="tok",
                         site="Engineering",
                         drive="Documents",
                         key_prefix="team/../private")


@pytest.mark.asyncio
async def test_scoped_resolve_unknown_drive():
    accessor = _scoped_accessor()
    accessor.site_cache["Engineering"] = _SITE_ID
    drives_url = re.compile(r".*/sites/.*/drives.*")
    with aioresponses() as m:
        m.get(drives_url, payload={"value": [{"id": "x", "name": "Other"}]})
        result = await resolve(accessor, _spec("/sp/a.txt"))
    assert result.level == "drive"
    assert result.drive_id is None
