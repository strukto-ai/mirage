from collections.abc import AsyncIterator

import pytest

from mirage.types import FileChangeKind, PathSpec, WalkEntry
from mirage.watch.delta import ListingDeltaHook


def _walk_from(tree: dict[str, str | None]):
    """Build a walk callable from a {virtual: fingerprint|None} tree.

    A None fingerprint marks a directory.
    """

    async def _walk(root: PathSpec) -> AsyncIterator[WalkEntry]:
        for virtual, fingerprint in tree.items():
            yield WalkEntry(virtual=virtual,
                            is_dir=fingerprint is None,
                            fingerprint=fingerprint)

    return _walk


def _root() -> PathSpec:
    return PathSpec.from_str_path("/nc")


@pytest.mark.asyncio
async def test_baseline_pull_emits_nothing():
    hook = ListingDeltaHook(_walk_from({"/nc/a.txt": "e1"}))
    delta = await hook.pull(_root(), None)
    assert delta.changes == ()
    assert delta.checkpoint is not None


@pytest.mark.asyncio
async def test_create_detected():
    tree: dict[str, str | None] = {"/nc/a.txt": "e1"}
    hook = ListingDeltaHook(_walk_from(tree))
    base = await hook.pull(_root(), None)
    tree["/nc/b.txt"] = "e2"
    delta = await hook.pull(_root(), base.checkpoint)
    kinds = {(c.path.virtual, c.kind) for c in delta.changes}
    assert ("/nc/b.txt", FileChangeKind.CREATE) in kinds
    assert len(delta.changes) == 1


@pytest.mark.asyncio
async def test_update_detected_via_fingerprint_change():
    tree: dict[str, str | None] = {"/nc/a.txt": "e1"}
    hook = ListingDeltaHook(_walk_from(tree))
    base = await hook.pull(_root(), None)
    tree["/nc/a.txt"] = "e2"
    delta = await hook.pull(_root(), base.checkpoint)
    assert len(delta.changes) == 1
    assert delta.changes[0].kind is FileChangeKind.UPDATE
    assert delta.changes[0].metadata is not None
    assert delta.changes[0].metadata.fingerprint == "e2"


@pytest.mark.asyncio
async def test_delete_detected():
    tree: dict[str, str | None] = {"/nc/a.txt": "e1", "/nc/b.txt": "e2"}
    hook = ListingDeltaHook(_walk_from(tree))
    base = await hook.pull(_root(), None)
    del tree["/nc/b.txt"]
    delta = await hook.pull(_root(), base.checkpoint)
    assert len(delta.changes) == 1
    assert delta.changes[0].kind is FileChangeKind.DELETE
    assert delta.changes[0].path.virtual == "/nc/b.txt"


@pytest.mark.asyncio
async def test_metadata_carries_size_and_modified():

    async def _walk(root: PathSpec) -> AsyncIterator[WalkEntry]:
        yield WalkEntry(virtual="/nc/a.txt",
                        is_dir=False,
                        fingerprint="e2",
                        size=2,
                        modified="2026-01-02T00:00:00")

    hook = ListingDeltaHook(_walk)
    base = await ListingDeltaHook(_walk_from({"/nc/a.txt":
                                              "e1"})).pull(_root(), None)
    delta = await hook.pull(_root(), base.checkpoint)
    meta = delta.changes[0].metadata
    assert delta.changes[0].kind is FileChangeKind.UPDATE
    assert meta is not None
    assert meta.fingerprint == "e2"
    assert meta.size == 2
    assert meta.modified == "2026-01-02T00:00:00"


@pytest.mark.asyncio
async def test_no_change_between_identical_pulls():
    tree: dict[str, str | None] = {"/nc/a.txt": "e1", "/nc/sub": None}
    hook = ListingDeltaHook(_walk_from(tree))
    base = await hook.pull(_root(), None)
    delta = await hook.pull(_root(), base.checkpoint)
    assert delta.changes == ()


@pytest.mark.asyncio
async def test_directory_fingerprint_not_reported():
    tree: dict[str, str | None] = {"/nc/sub": None}
    hook = ListingDeltaHook(_walk_from(tree))
    base = await hook.pull(_root(), None)
    tree["/nc/sub/x.txt"] = "e1"
    delta = await hook.pull(_root(), base.checkpoint)
    created = {c.path.virtual: c for c in delta.changes}
    assert created["/nc/sub/x.txt"].metadata.fingerprint == "e1"
