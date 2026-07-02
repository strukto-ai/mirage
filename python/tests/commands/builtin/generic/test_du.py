import pytest

from mirage.commands.builtin.generic.du import _depth, du, du_multi
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


def _make_list_backend(tree: dict[str, int]):
    """Build (compute_total, compute_all) where compute_all returns a flat
    list (NOT a (list, total) tuple), matching the backend `du_all` contract
    consumed by `du_multi`. Directory targets include a trailing
    (dirpath, total) entry, mirroring the real backends."""

    async def compute_total(p: PathSpec) -> int:
        prefix = p.virtual.rstrip("/") + "/"
        return sum(size for path, size in tree.items()
                   if path == p.virtual or path.startswith(prefix))

    async def compute_all(p: PathSpec) -> list[tuple[str, int]]:
        prefix = p.virtual.rstrip("/") + "/"
        entries: list[tuple[str, int]] = []
        total = 0
        for path, size in sorted(tree.items()):
            if path == p.virtual or path.startswith(prefix):
                entries.append((path, size))
                total += size
        if p.virtual not in dict(entries):
            entries.append((p.virtual, total))
        return entries

    return compute_total, compute_all


def _make_backend(tree: dict[str, int]):
    """Build (compute_total, compute_all) callables over an in-memory tree.

    `tree` maps every file path → size. Directory totals are inferred by
    walking the tree on demand, matching `du_all` semantics in the real
    backends (returns flat file entries + recursive total).
    """

    async def compute_total(p: PathSpec) -> int:
        prefix = p.virtual.rstrip("/") + "/"
        total = 0
        for path, size in tree.items():
            if path == p.virtual or path.startswith(prefix):
                total += size
        return total

    async def compute_all(p: PathSpec, ) -> tuple[list[tuple[str, int]], int]:
        prefix = p.virtual.rstrip("/") + "/"
        entries: list[tuple[str, int]] = []
        total = 0
        for path, size in sorted(tree.items()):
            if path == p.virtual or path.startswith(prefix):
                entries.append((path, size))
                total += size
        return entries, total

    return compute_total, compute_all


@pytest.mark.asyncio
async def test_du_single_file_default():
    compute_total, compute_all = _make_backend({"/f.txt": 5})
    out = await du([_spec("/f.txt")],
                   compute_total=compute_total,
                   compute_all=compute_all)
    assert out == "5\t/f.txt\n"


@pytest.mark.asyncio
async def test_du_directory_collapses_to_root_when_not_a():
    """POSIX `du` default behavior: one line per dir, files not shown."""
    tree = {"/dir/a.txt": 3, "/dir/b.txt": 2}
    compute_total, compute_all = _make_backend(tree)
    out = await du([_spec("/dir")],
                   compute_total=compute_total,
                   compute_all=compute_all)
    assert out == "5\t/dir\n"


@pytest.mark.asyncio
async def test_du_a_lists_all_files():
    tree = {"/dir/a.txt": 3, "/dir/b.txt": 2}
    compute_total, compute_all = _make_backend(tree)
    out = await du([_spec("/dir")],
                   compute_total=compute_total,
                   compute_all=compute_all,
                   a=True)
    lines = out.splitlines()
    assert "3\t/dir/a.txt" in lines
    assert "2\t/dir/b.txt" in lines


@pytest.mark.asyncio
async def test_du_s_summary_single_line():
    tree = {"/dir/a.txt": 3, "/dir/sub/b.txt": 2}
    compute_total, compute_all = _make_backend(tree)
    out = await du([_spec("/dir")],
                   compute_total=compute_total,
                   compute_all=compute_all,
                   s=True)
    assert out == "5\t/dir\n"


@pytest.mark.asyncio
async def test_du_max_depth_zero_in_a_mode_drops_everything_below():
    """`-a --max-depth 0` keeps only entries at depth 0 (the root). Since
    file entries are at depth ≥ 1, no entries remain → falls back to
    single-line root output."""
    tree = {"/dir/a.txt": 3, "/dir/sub/b.txt": 2}
    compute_total, compute_all = _make_backend(tree)
    out = await du([_spec("/dir")],
                   compute_total=compute_total,
                   compute_all=compute_all,
                   a=True,
                   max_depth=0)
    assert out == "5\t/dir\n"


@pytest.mark.asyncio
async def test_du_max_depth_one_keeps_direct_children():
    tree = {"/dir/a.txt": 3, "/dir/sub/b.txt": 2}
    compute_total, compute_all = _make_backend(tree)
    out = await du([_spec("/dir")],
                   compute_total=compute_total,
                   compute_all=compute_all,
                   a=True,
                   max_depth=1)
    lines = out.splitlines()
    assert "3\t/dir/a.txt" in lines
    assert not any("sub/b.txt" in ln for ln in lines)


@pytest.mark.asyncio
async def test_du_c_appends_total_line():
    tree = {"/dir/a.txt": 3, "/dir/b.txt": 2}
    compute_total, compute_all = _make_backend(tree)
    out = await du([_spec("/dir")],
                   compute_total=compute_total,
                   compute_all=compute_all,
                   c=True)
    assert out.splitlines()[-1] == "5\ttotal"


@pytest.mark.asyncio
async def test_du_h_human_readable_size():
    tree = {"/big.txt": 2048}
    compute_total, compute_all = _make_backend(tree)
    out = await du([_spec("/big.txt")],
                   compute_total=compute_total,
                   compute_all=compute_all,
                   h=True)
    assert "/big.txt" in out
    assert out.split("\t")[0].endswith("K")


@pytest.mark.asyncio
async def test_du_multi_path_independent_outputs():
    tree = {"/a.txt": 3, "/b.txt": 7}
    compute_total, compute_all = _make_backend(tree)
    out = await du([_spec("/a.txt"), _spec("/b.txt")],
                   compute_total=compute_total,
                   compute_all=compute_all)
    assert out == "3\t/a.txt\n7\t/b.txt\n"


@pytest.mark.asyncio
async def test_du_multi_path_with_c_grand_total():
    tree = {"/a.txt": 3, "/b.txt": 7}
    compute_total, compute_all = _make_backend(tree)
    out = await du([_spec("/a.txt"), _spec("/b.txt")],
                   compute_total=compute_total,
                   compute_all=compute_all,
                   c=True)
    assert out.splitlines()[-1] == "10\ttotal"


@pytest.mark.asyncio
async def test_du_multi_path_with_h_and_c_sums_raw_bytes():
    """-c with -h should still sum the raw byte counts correctly. (Previous
    string-parse implementation got 0 here because '1.0K' wasn't int())."""
    tree = {"/a.txt": 1024, "/b.txt": 1024}
    compute_total, compute_all = _make_backend(tree)
    out = await du([_spec("/a.txt"), _spec("/b.txt")],
                   compute_total=compute_total,
                   compute_all=compute_all,
                   h=True,
                   c=True)
    total_line = out.splitlines()[-1]
    assert total_line.endswith("\ttotal")
    assert total_line.split("\t")[0].endswith("K")


@pytest.mark.asyncio
async def test_du_empty_target_returns_zero_with_path():
    compute_total, compute_all = _make_backend({})
    out = await du([_spec("/nothing")],
                   compute_total=compute_total,
                   compute_all=compute_all)
    assert out == "0\t/nothing\n"


@pytest.mark.asyncio
async def test_du_multi_independent_outputs_bytes():
    compute_total, compute_all = _make_list_backend({"/a.txt": 3, "/b.txt": 7})
    out = await du_multi([_spec("/a.txt"), _spec("/b.txt")],
                         compute_total=compute_total,
                         compute_all=compute_all)
    assert out == b"3\t/a.txt\n7\t/b.txt\n"


@pytest.mark.asyncio
async def test_du_multi_c_grand_total_sums_all_paths():
    compute_total, compute_all = _make_list_backend({"/a.txt": 3, "/b.txt": 7})
    out = await du_multi([_spec("/a.txt"), _spec("/b.txt")],
                         compute_total=compute_total,
                         compute_all=compute_all,
                         c=True)
    assert out.decode().splitlines()[-1] == "10\ttotal"


@pytest.mark.asyncio
async def test_du_multi_directory_collapses_when_not_a():
    tree = {"/dir/a.txt": 3, "/dir/b.txt": 2}
    compute_total, compute_all = _make_list_backend(tree)
    out = await du_multi([_spec("/dir")],
                         compute_total=compute_total,
                         compute_all=compute_all)
    assert out == b"5\t/dir\n"


@pytest.mark.asyncio
async def test_du_multi_a_lists_files():
    tree = {"/dir/a.txt": 3, "/dir/b.txt": 2}
    compute_total, compute_all = _make_list_backend(tree)
    out = await du_multi([_spec("/dir")],
                         compute_total=compute_total,
                         compute_all=compute_all,
                         a=True)
    lines = out.decode().splitlines()
    assert "3\t/dir/a.txt" in lines
    assert "2\t/dir/b.txt" in lines


@pytest.mark.asyncio
async def test_du_multi_compute_all_none_emits_total_only():
    """Walk-only backends (gdrive, github) pass compute_all=None: each path
    yields a single total line; -c still sums across paths."""
    compute_total, _ = _make_list_backend({"/x/a": 4, "/x/b": 6, "/y/c": 5})
    out = await du_multi([_spec("/x"), _spec("/y")],
                         compute_total=compute_total,
                         compute_all=None,
                         c=True)
    assert out.decode().splitlines() == ["10\t/x", "5\t/y", "15\ttotal"]


def test_depth_helper_root_is_zero():
    assert _depth("/dir", "/dir") == 0


def test_depth_helper_direct_child_is_one():
    assert _depth("/dir/a.txt", "/dir") == 1


def test_depth_helper_nested():
    assert _depth("/dir/sub/b.txt", "/dir") == 2
