from collections.abc import AsyncIterator

import pytest

from mirage.types import ChangeKind, PathSpec
from mirage.watch.poller import (ListingDeltaHook, WalkEntry,
                                 default_fingerprint)


def test_default_fingerprint_prefers_etag():
    assert default_fingerprint("etag-1", "2026-01-01T00:00:00", 5) == "etag-1"


def test_default_fingerprint_falls_back_to_mtime_size():
    assert default_fingerprint(None, "2026-01-01T00:00:00",
                               5) == "2026-01-01T00:00:00|5"


def test_default_fingerprint_handles_missing_fields():
    assert default_fingerprint(None, None, None) == "|None"


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
    assert delta.changes[0].fingerprint == "e2"


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
    assert created["/nc/sub/x.txt"].fingerprint == "e1"
