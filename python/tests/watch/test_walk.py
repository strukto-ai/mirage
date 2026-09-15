import asyncio

import pytest

from mirage.cache.index import IndexCacheStore
from mirage.types import FileStat, FileType, PathSpec
from mirage.watch.walk import ReaddirWalk, entry_of, synth_dirs


def _root(virtual: str, resource_path: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=resource_path)


def test_synth_dirs_emits_every_ancestor_excluding_the_root():
    dirs = [
        e.virtual for e in synth_dirs("/m/data", ["/m/data/a/b/c.txt"], [])
    ]
    assert dirs == ["/m/data/a/b", "/m/data/a"]


def test_synth_dirs_reports_a_shared_prefix_once():
    dirs = list(
        synth_dirs("/m/data", ["/m/data/a/x.txt", "/m/data/a/y.txt"], []))
    assert [e.virtual for e in dirs] == ["/m/data/a"]


def test_synth_dirs_emits_a_stored_directory_with_no_children():
    dirs = list(synth_dirs("/m/data", [], ["/m/data/empty"]))
    assert [e.virtual for e in dirs] == ["/m/data/empty"]


def test_synth_dirs_does_not_double_report_a_marker_with_children():
    dirs = list(synth_dirs("/m/data", ["/m/data/a/x.txt"], ["/m/data/a"]))
    assert [e.virtual for e in dirs] == ["/m/data/a"]


def test_synth_dirs_rows_are_directories_without_fingerprints():
    dirs = list(synth_dirs("/m/data", ["/m/data/a/x.txt"], []))
    assert all(e.is_dir and e.fingerprint is None for e in dirs)


def test_synth_dirs_emits_nothing_for_a_file_at_the_root():
    assert list(synth_dirs("/m/data", ["/m/data/x.txt"], [])) == []


def test_entry_of_reports_a_directory_without_a_fingerprint():
    entry = entry_of("/m/d", FileStat(name="d", type=FileType.DIRECTORY))
    assert entry.is_dir is True
    assert entry.fingerprint is None


def test_entry_of_folds_the_backend_fingerprint_into_the_composite():
    stat = FileStat(type=FileType.FILE,
                    name="f.txt",
                    size=3,
                    modified="T",
                    fingerprint="etag-1")
    assert entry_of("/m/f.txt", stat).fingerprint == "etag-1|T|3"


def test_entry_of_composites_without_a_backend_fingerprint():
    stat = FileStat(type=FileType.FILE, name="f.txt", size=3, modified="T")
    assert entry_of("/m/f.txt", stat).fingerprint == "|T|3"


def _backend(tree: dict[str, dict]) -> ReaddirWalk:

    async def readdir(spec: PathSpec, index: IndexCacheStore) -> list[str]:
        node = tree.get(spec.virtual)
        if node is None or "children" not in node:
            raise FileNotFoundError(spec.virtual)
        return list(node["children"])

    async def stat(spec: PathSpec, index: IndexCacheStore) -> FileStat:
        node = tree.get(spec.virtual)
        if node is None:
            raise FileNotFoundError(spec.virtual)
        return node["stat"]

    return ReaddirWalk(readdir, stat)


async def _collect(walk: ReaddirWalk, spec: PathSpec) -> list:
    return [entry async for entry in walk(spec)]


def test_readdir_walk_descends_and_reports_leaves():
    walk = _backend({
        "/m/data": {
            "children": ["/m/data/a.txt", "/m/data/sub"],
            "stat": FileStat(name="data", type=FileType.DIRECTORY),
        },
        "/m/data/a.txt": {
            "stat":
            FileStat(type=FileType.FILE,
                     name="a.txt",
                     size=5,
                     modified="T1",
                     fingerprint="fp-a")
        },
        "/m/data/sub": {
            "children": ["/m/data/sub/deep.txt"],
            "stat": FileStat(name="sub", type=FileType.DIRECTORY),
        },
        "/m/data/sub/deep.txt": {
            "stat":
            FileStat(type=FileType.FILE,
                     name="deep.txt",
                     size=4,
                     modified="T2",
                     fingerprint="fp-d")
        },
    })
    entries = asyncio.run(_collect(walk, _root("/m/data", "data")))
    assert [e.virtual for e in entries] == [
        "/m/data/a.txt",
        "/m/data/sub",
        "/m/data/sub/deep.txt",
    ]
    assert [e.virtual for e in entries if e.is_dir] == ["/m/data/sub"]


def test_readdir_walk_trusts_a_trailing_slash_without_a_stat():
    # No stat entry for the child at all: the slash is the proof, so a
    # stat would raise and the walk would lose the subtree.
    walk = _backend({
        "/m/data": {
            "children": ["/m/data/sub/"],
            "stat": FileStat(name="data", type=FileType.DIRECTORY),
        },
        "/m/data/sub": {
            "children": [],
            "stat": FileStat(name="sub", type=FileType.DIRECTORY),
        },
    })
    entries = asyncio.run(_collect(walk, _root("/m/data", "data")))
    assert [(e.virtual, e.is_dir) for e in entries] == [("/m/data/sub", True)]


def test_readdir_walk_skips_an_entry_that_vanished_mid_walk():
    walk = _backend({
        "/m/data": {
            "children": ["/m/data/gone.txt", "/m/data/here.txt"],
            "stat": FileStat(name="data", type=FileType.DIRECTORY),
        },
        "/m/data/here.txt": {
            "stat":
            FileStat(type=FileType.FILE,
                     name="here.txt",
                     size=1,
                     modified="T",
                     fingerprint="fp")
        },
    })
    entries = asyncio.run(_collect(walk, _root("/m/data", "data")))
    assert [e.virtual for e in entries] == ["/m/data/here.txt"]


def test_readdir_walk_treats_a_missing_root_as_empty():
    entries = asyncio.run(_collect(_backend({}), _root("/m/gone", "gone")))
    assert entries == []


def test_readdir_walk_propagates_a_non_absence_error():

    async def readdir(spec: PathSpec, index: IndexCacheStore) -> list[str]:
        raise PermissionError("rate limited")

    async def stat(spec: PathSpec, index: IndexCacheStore) -> FileStat:
        raise AssertionError("unreachable")

    with pytest.raises(PermissionError):
        asyncio.run(
            _collect(ReaddirWalk(readdir, stat), _root("/m/data", "data")))


def test_readdir_walk_starts_from_an_empty_index_on_every_call():
    seen: list[IndexCacheStore] = []

    async def readdir(spec: PathSpec, index: IndexCacheStore) -> list[str]:
        seen.append(index)
        return ["/m/data/a.txt"] if spec.virtual == "/m/data" else []

    async def stat(spec: PathSpec, index: IndexCacheStore) -> FileStat:
        return FileStat(type=FileType.FILE,
                        name="a.txt",
                        size=1,
                        modified="T",
                        fingerprint="fp")

    walk = ReaddirWalk(readdir, stat)
    root = _root("/m/data", "data")
    asyncio.run(_collect(walk, root))
    asyncio.run(_collect(walk, root))
    # Two pulls, two distinct index instances: nothing a pull learned
    # can leak into the next one's snapshot.
    assert seen[0] is not seen[-1]
