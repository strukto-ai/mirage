from dataclasses import dataclass

import pytest

from mirage.core.generic.find import make_search_backed_find, relative_depth
from mirage.types import FileStat, FileType, PathSpec

KEYS = ["/", "/guides", "/guides/quickstart", "/api", "/api/reference"]

DIRS = {"/", "/guides", "/api"}

SIZES = {"/guides/quickstart": 40, "/api/reference": 900}


@dataclass(frozen=True)
class Resolved:
    is_dir: bool


class Ops:

    def __init__(self, keys: list[str] | None = None) -> None:
        self.keys = KEYS if keys is None else keys
        self.walk_kwargs: dict[str, object] = {}
        self.resolve_calls = 0
        self.stat_calls = 0
        self.probes: list[PathSpec] = []

    async def walk(self, accessor, path, index, **kwargs):
        self.walk_kwargs = kwargs
        return list(self.keys)

    async def resolve_path(self, accessor, spec, index):
        self.probes.append(spec)
        self.resolve_calls += 1
        return Resolved(is_dir=spec.mount_path.rstrip("/") in
                        {d.rstrip("/")
                         for d in DIRS} or spec.mount_path == "/")

    async def stat(self, accessor, spec, index):
        self.probes.append(spec)
        self.stat_calls += 1
        return FileStat(type=FileType.FILE,
                        name=spec.mount_path.rsplit("/", 1)[-1],
                        size=SIZES.get(spec.mount_path))


def build(ops: Ops):
    return make_search_backed_find(ops.resolve_path, ops.stat, ops.walk)


ROOT = PathSpec.from_str_path("/", "")


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["", "/knowledge", "/api", "/nested/mount"])
@pytest.mark.parametrize("root", ["/", "/api"])
async def test_metadata_probes_preserve_both_paths(prefix, root):
    keys = ["/", "/api", "/api/reference"
            ] if root == "/" else ["/api", "/api/reference"]
    ops = Ops(keys=keys)
    path = PathSpec.from_str_path((prefix + root).rstrip("/") or "/",
                                  root.lstrip("/"))
    assert await build(ops)(object(), path, type="f",
                            min_size=1) == ["/api/reference"]
    assert {(p.virtual, p.resource_path)
            for p in ops.probes} == {((prefix + key).rstrip("/")
                                      or "/", key.lstrip("/"))
                                     for key in keys}


@pytest.mark.asyncio
async def test_every_walked_key_comes_back_sorted():
    ops = Ops()
    find = build(ops)
    assert await find(object(), ROOT) == sorted(KEYS)


@pytest.mark.asyncio
async def test_name_filters_on_the_basename():
    ops = Ops()
    find = build(ops)
    assert await find(object(), ROOT, name="reference") == ["/api/reference"]


@pytest.mark.asyncio
async def test_maxdepth_is_pushed_into_the_walk():
    ops = Ops()
    find = build(ops)
    await find(object(), ROOT, maxdepth=1)
    assert ops.walk_kwargs == {
        "include_root": True,
        "maxdepth": 1,
        "strip_prefix": True,
    }


@pytest.mark.asyncio
async def test_a_plain_walk_needs_neither_resolve_nor_stat():
    # Nothing asked for a kind, a size or an mtime, so the filter must not
    # spend one backend call per entry.
    ops = Ops()
    find = build(ops)
    await find(object(), ROOT)
    assert (ops.resolve_calls, ops.stat_calls) == (0, 0)


@pytest.mark.asyncio
async def test_size_bounds_keep_only_files_in_range():
    ops = Ops()
    find = build(ops)
    assert await find(object(), ROOT, min_size=100) == ["/api/reference"]


@pytest.mark.asyncio
async def test_directories_count_as_size_zero():
    # The deliberate GNU divergence in CLAUDE.md: a directory is size 0,
    # so an upper bound of 0 keeps every directory and drops both files.
    ops = Ops()
    find = build(ops)
    assert await find(object(), ROOT, max_size=0) == sorted(DIRS)


@pytest.mark.asyncio
async def test_a_sizeless_file_counts_as_size_zero():
    ops = Ops(keys=["/", "/unsized"])
    find = build(ops)
    assert await find(object(), ROOT, max_size=0) == ["/", "/unsized"]


@pytest.mark.asyncio
async def test_empty_reads_a_directory_off_the_walked_list():
    # The whole subtree came from one walk, so a directory is empty
    # exactly when no other walked key sits under it -- no extra readdir.
    ops = Ops(keys=["/", "/guides", "/api", "/api/reference"])
    find = build(ops)
    assert await find(object(), ROOT, empty=True) == ["/guides"]


@pytest.mark.asyncio
async def test_empty_keeps_a_zero_length_file():
    ops = Ops(keys=["/", "/api", "/api/reference", "/unsized"])
    find = build(ops)
    assert await find(object(), ROOT, empty=True) == ["/unsized"]


@pytest.mark.asyncio
async def test_empty_forces_the_kind_lookup_it_branches_on():
    # -empty asks a different question of directories than of files, so
    # it has to force the kind lookup the way -type does. Without that
    # every entry reads as a file and a childless directory gets judged
    # by a size it does not have.
    ops = Ops(keys=["/", "/guides", "/api", "/api/reference"])
    find = build(ops)
    await find(object(), ROOT, empty=True)
    assert ops.resolve_calls == 4


@pytest.mark.parametrize("item,root,expected", [
    ("/", "/", 0),
    ("/guides", "/", 1),
    ("/guides/quickstart", "/", 2),
    ("/guides/", "/", 1),
    ("/a/b/c", "/a", 2),
    ("/a", "/a", 0),
])
def test_relative_depth(item, root, expected):
    assert relative_depth(item, root) == expected
