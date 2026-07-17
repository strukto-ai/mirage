from types import SimpleNamespace

import pytest

import mirage.core.msgraph.drive_ops as drive_ops
from mirage.core.sharepoint import find as find_mod
from mirage.core.sharepoint._resolver import ResolvedPath
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_TREE = [
    ("reports/a.txt", {
        "name": "a.txt",
        "size": 10,
        "lastModifiedDateTime": "2026-07-15T12:00:00Z"
    }, False),
    ("reports/sub", {
        "name": "sub",
        "lastModifiedDateTime": "2026-07-14T12:00:00Z",
        "folder": {}
    }, True),
    ("reports/sub/b.txt", {
        "name": "b.txt",
        "size": 20,
        "lastModifiedDateTime": "2026-07-13T12:00:00Z"
    }, False),
]


class _FakeSession:

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


async def _fake_iter_tree(config, loc, session=None):
    for rel, item, is_dir in _TREE:
        yield rel, item, is_dir


async def _fake_resolve(accessor, path):
    return ResolvedPath(level="item", drive_id="d", item_path="reports")


@pytest.fixture
def _patched(monkeypatch):
    monkeypatch.setattr(find_mod, "resolve", _fake_resolve)
    monkeypatch.setattr(drive_ops, "iter_tree", _fake_iter_tree)
    monkeypatch.setattr(drive_ops, "new_session",
                        lambda config: _FakeSession())


def _spec() -> PathSpec:
    return PathSpec(resource_path=mount_key("/sp/reports", "/sp"),
                    virtual="/sp/reports",
                    directory="/sp/reports")


@pytest.mark.asyncio
async def test_find_emits_mount_root(_patched):
    acc = SimpleNamespace(config=None)
    out = await find_mod.find(acc, _spec())
    assert out == [
        "/reports", "/reports/a.txt", "/reports/sub", "/reports/sub/b.txt"
    ]


@pytest.mark.asyncio
async def test_find_name_matches_mount_root_start_path(_patched):
    acc = SimpleNamespace(config=None)
    out = await find_mod.find(acc, _spec(), name="reports")
    assert out == ["/reports"]


@pytest.mark.asyncio
async def test_find_type_dir_includes_root(_patched):
    acc = SimpleNamespace(config=None)
    out = await find_mod.find(acc, _spec(), type="d")
    assert out == ["/reports", "/reports/sub"]


@pytest.mark.asyncio
async def test_find_maxdepth_one(_patched):
    acc = SimpleNamespace(config=None)
    out = await find_mod.find(acc, _spec(), maxdepth=1)
    assert out == ["/reports", "/reports/a.txt", "/reports/sub"]
