from collections.abc import AsyncIterator

import pytest

from mirage.types import ChangeKind, PathSpec
from mirage.watch.poller import ListingDeltaHook, WalkEntry


def _walk_from(tree: dict[str, str | None]):
    """Build a walk callable from a {virtual: detector|None} tree.

    A None detector marks a directory.
    """

    async def _walk(root: PathSpec) -> AsyncIterator[WalkEntry]:
        for virtual, detector in tree.items():
            yield WalkEntry(virtual=virtual,
                            is_dir=detector is None,
                            detector=detector)

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
    assert ("/nc/b.txt", ChangeKind.CREATE) in kinds
    assert len(delta.changes) == 1


@pytest.mark.asyncio
async def test_update_detected_via_detector_change():
    tree: dict[str, str | None] = {"/nc/a.txt": "e1"}
    hook = ListingDeltaHook(_walk_from(tree))
    base = await hook.pull(_root(), None)
    tree["/nc/a.txt"] = "e2"
    delta = await hook.pull(_root(), base.checkpoint)
    assert len(delta.changes) == 1
    assert delta.changes[0].kind is ChangeKind.UPDATE
    assert delta.changes[0].version == "e2"


@pytest.mark.asyncio
async def test_delete_detected():
    tree: dict[str, str | None] = {"/nc/a.txt": "e1", "/nc/b.txt": "e2"}
    hook = ListingDeltaHook(_walk_from(tree))
    base = await hook.pull(_root(), None)
    del tree["/nc/b.txt"]
    delta = await hook.pull(_root(), base.checkpoint)
    assert len(delta.changes) == 1
    assert delta.changes[0].kind is ChangeKind.DELETE
    assert delta.changes[0].path.virtual == "/nc/b.txt"


@pytest.mark.asyncio
async def test_no_change_between_identical_pulls():
    tree: dict[str, str | None] = {"/nc/a.txt": "e1", "/nc/sub": None}
    hook = ListingDeltaHook(_walk_from(tree))
    base = await hook.pull(_root(), None)
    delta = await hook.pull(_root(), base.checkpoint)
    assert delta.changes == ()


@pytest.mark.asyncio
async def test_directory_detector_not_reported_as_version():
    tree: dict[str, str | None] = {"/nc/sub": None}
    hook = ListingDeltaHook(_walk_from(tree))
    base = await hook.pull(_root(), None)
    tree["/nc/sub/x.txt"] = "e1"
    delta = await hook.pull(_root(), base.checkpoint)
    created = {c.path.virtual: c for c in delta.changes}
    assert created["/nc/sub/x.txt"].version == "e1"
