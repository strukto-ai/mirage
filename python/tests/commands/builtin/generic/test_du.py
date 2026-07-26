import pytest

from mirage.commands.builtin.generic.du import (DuFlags, _depth, du,
                                                parse_depth, parse_flags,
                                                rollup, to_virtual)
from mirage.commands.errors import UsageError
from mirage.types import PathSpec


def _spec(virtual: str, resource_path: str, raw_path: str | None = None):
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=resource_path,
                    raw_path=raw_path)


def _make_backend(tree: dict[str, int]):
    """Build (compute_size, compute_entries) over an in-memory tree.

    ``tree`` maps mount-relative paths to sizes, which is the domain every
    backend reports in.

    Args:
        tree (dict[str, int]): mount-relative path -> byte size.
    """

    async def compute_size(p: PathSpec) -> int:
        base = p.mount_path.rstrip("/")
        return sum(size for path, size in tree.items()
                   if path == base or path.startswith(base + "/"))

    async def compute_entries(
            p: PathSpec) -> tuple[list[tuple[str, int]], int]:
        base = p.mount_path.rstrip("/")
        found = sorted((path, size) for path, size in tree.items()
                       if path == base or path.startswith(base + "/"))
        return found, sum(size for _, size in found)

    return compute_size, compute_entries


@pytest.mark.asyncio
async def test_single_file_reports_its_size():
    compute_size, compute_entries = _make_backend({"/f.txt": 5})
    out = await du([_spec("/f.txt", "f.txt")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags())
    assert out.stdout == b"5\t/f.txt\n"
    assert out.exit_code == 0


@pytest.mark.asyncio
async def test_file_operand_prints_once_under_a():
    """GNU prints a file operand as a single line, never file + roll-up."""
    compute_size, compute_entries = _make_backend({"/f.txt": 5})
    out = await du([_spec("/f.txt", "f.txt")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(a=True))
    assert out.stdout == b"5\t/f.txt\n"


@pytest.mark.asyncio
async def test_directory_of_files_only_prints_the_operand():
    tree = {"/dir/a.txt": 2, "/dir/b.txt": 3}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags())
    assert out.stdout == b"5\t/dir\n"


@pytest.mark.asyncio
async def test_subdirectories_get_their_own_line():
    """GNU prints a line per directory carrying its recursive total."""
    tree = {"/dir/a.txt": 3, "/dir/sub/b.txt": 2, "/dir/sub/deep/c.txt": 1}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags())
    assert out.stdout == b"1\t/dir/sub/deep\n3\t/dir/sub\n6\t/dir\n"


@pytest.mark.asyncio
async def test_a_lists_every_file_then_every_directory():
    """Post-order: children before parents, exactly like GNU."""
    tree = {"/dir/a.txt": 3, "/dir/sub/b.txt": 2, "/dir/sub/deep/c.txt": 1}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(a=True))
    assert out.stdout == (b"3\t/dir/a.txt\n"
                          b"2\t/dir/sub/b.txt\n"
                          b"1\t/dir/sub/deep/c.txt\n"
                          b"1\t/dir/sub/deep\n"
                          b"3\t/dir/sub\n"
                          b"6\t/dir\n")


@pytest.mark.asyncio
async def test_a_lists_every_file():
    tree = {"/dir/a.txt": 2, "/dir/b.txt": 3}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(a=True))
    assert out.stdout == b"2\t/dir/a.txt\n3\t/dir/b.txt\n5\t/dir\n"


@pytest.mark.asyncio
async def test_a_entries_carry_the_mount_prefix():
    """The backend walks its own key space; du must show virtual paths."""
    compute_size, compute_entries = _make_backend({"/notes.txt": 4})
    out = await du([_spec("/slack", "")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(a=True))
    assert out.stdout == b"4\t/slack/notes.txt\n4\t/slack\n"


@pytest.mark.asyncio
async def test_a_distinguishes_same_name_under_two_mounts():
    """Two mounts each holding notes.txt must not render the same line."""
    compute_size, compute_entries = _make_backend({"/notes.txt": 4})
    first = await du([_spec("/m1", "")],
                     compute_size=compute_size,
                     compute_entries=compute_entries,
                     flags=DuFlags(a=True))
    second = await du([_spec("/m2", "")],
                      compute_size=compute_size,
                      compute_entries=compute_entries,
                      flags=DuFlags(a=True))
    assert first.stdout == b"4\t/m1/notes.txt\n4\t/m1\n"
    assert second.stdout == b"4\t/m2/notes.txt\n4\t/m2\n"
    assert first.stdout != second.stdout


@pytest.mark.asyncio
async def test_a_respells_entries_as_the_operand_was_typed():
    compute_size, compute_entries = _make_backend({"/dir/a.txt": 2})
    out = await du([_spec("/dir", "dir", raw_path="dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(a=True))
    assert out.stdout == b"2\tdir/a.txt\n2\tdir\n"


@pytest.mark.asyncio
async def test_s_summarises_to_one_line():
    tree = {"/dir/a.txt": 2, "/dir/sub/b.txt": 3}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(s=True))
    assert out.stdout == b"5\t/dir\n"


@pytest.mark.asyncio
async def test_max_depth_zero_drops_everything_below_the_operand():
    tree = {"/dir/a.txt": 2, "/dir/sub/b.txt": 3}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(a=True, max_depth=0))
    assert out.stdout == b"5\t/dir\n"


@pytest.mark.asyncio
async def test_max_depth_one_keeps_direct_children():
    tree = {"/dir/a.txt": 2, "/dir/sub/b.txt": 3}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(a=True, max_depth=1))
    assert out.stdout == b"2\t/dir/a.txt\n3\t/dir/sub\n5\t/dir\n"


@pytest.mark.asyncio
async def test_negative_max_depth_prints_only_the_operand():
    """GNU accepts a negative depth without complaint (exit 0)."""
    tree = {"/dir/a.txt": 2, "/dir/sub/b.txt": 3}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(max_depth=-1))
    assert out.stdout == b"5\t/dir\n"
    assert out.exit_code == 0


@pytest.mark.asyncio
async def test_c_appends_a_grand_total():
    tree = {"/dir/a.txt": 2, "/dir/b.txt": 3}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(c=True))
    assert out.stdout.splitlines()[-1] == b"5\ttotal"


@pytest.mark.asyncio
async def test_h_renders_human_readable_sizes():
    compute_size, compute_entries = _make_backend({"/dir/a.txt": 4096})
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(h=True))
    assert out.stdout.split(b"\t")[0].endswith(b"K")


@pytest.mark.asyncio
async def test_multiple_operands_render_in_order():
    tree = {"/a.txt": 2, "/b.txt": 3}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/a.txt", "a.txt"),
                    _spec("/b.txt", "b.txt")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags())
    assert out.stdout == b"2\t/a.txt\n3\t/b.txt\n"


@pytest.mark.asyncio
async def test_backend_without_entries_still_reports_a_total():
    compute_size, _ = _make_backend({"/dir/a.txt": 2})
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=None,
                   flags=DuFlags(a=True))
    assert out.stdout == b"2\t/dir\n"


@pytest.mark.asyncio
async def test_missing_operand_is_reported_and_exits_one():
    """GNU names the unreadable operand, prints the rest, exits 1."""
    compute_size, compute_entries = _make_backend({"/dir/a.txt": 2})
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(),
                   missing=["nosuch"])
    assert out.stdout == b"2\t/dir\n"
    assert out.stderr == (b"du: cannot access 'nosuch': "
                          b"No such file or directory\n")
    assert out.exit_code == 1


@pytest.mark.asyncio
async def test_c_still_prints_a_total_when_every_operand_is_missing():
    """GNU prints '0 total' even when it read nothing."""
    compute_size, compute_entries = _make_backend({})
    out = await du([],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(c=True),
                   missing=["nosuch"])
    assert out.stdout == b"0\ttotal\n"
    assert out.exit_code == 1


@pytest.mark.asyncio
async def test_truncated_walk_reports_partial_output_and_exits_one():
    """GNU du prints what it accounted for, warns, and exits 1."""
    compute_size, compute_entries = _make_backend({"/dir/a.txt": 2})
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(),
                   truncated=lambda: True)
    assert out.stdout == b"2\t/dir\n"
    assert out.exit_code == 1
    assert b"incomplete" in out.stderr


@pytest.mark.asyncio
async def test_untruncated_walk_is_silent_and_exits_zero():
    compute_size, compute_entries = _make_backend({"/dir/a.txt": 2})
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(),
                   truncated=lambda: False)
    assert out.stderr == b""
    assert out.exit_code == 0


def test_parse_flags_rejects_summarize_with_all():
    with pytest.raises(UsageError) as excinfo:
        parse_flags(s=True, a=True, h=False, c=False, max_depth=None)
    assert "cannot both summarize and show all entries" in str(excinfo.value)
    assert excinfo.value.exit_code == 1


def test_parse_flags_rejects_summarize_with_max_depth():
    with pytest.raises(UsageError) as excinfo:
        parse_flags(s=True, a=False, h=False, c=False, max_depth="1")
    assert "summarizing conflicts with --max-depth=1" in str(excinfo.value)


def test_parse_flags_rejects_a_non_numeric_depth():
    with pytest.raises(UsageError) as excinfo:
        parse_flags(s=False, a=False, h=False, c=False, max_depth="1x")
    assert "invalid maximum depth '1x'" in str(excinfo.value)


def test_parse_flags_reports_a_bad_depth_before_the_conflict():
    """GNU parses --max-depth as it reads it, ahead of the -s/-a check."""
    with pytest.raises(UsageError) as excinfo:
        parse_flags(s=True, a=True, h=False, c=False, max_depth="abc")
    assert "invalid maximum depth" in str(excinfo.value)


@pytest.mark.parametrize("text,expected", [
    ("0", 0),
    ("2", 2),
    ("8", 8),
    ("+2", 2),
    ("-1", -1),
    ("-0", 0),
    ("010", 8),
    ("00", 0),
    ("0x2", 2),
    ("0X3", 3),
    ("09", None),
    ("0xz", None),
    ("1x", None),
    ("abc", None),
    ("1_0", None),
    ("١٢", None),
    (" 1 ", None),
])
def test_parse_depth_matches_gnu_strtoul(text, expected):
    """Pinned against debian coreutils: base 0, no whitespace."""
    assert parse_depth(text) == expected


def test_parse_flags_accepts_a_negative_depth():
    assert parse_flags(s=False, a=False, h=False, c=False,
                       max_depth="-1").max_depth == -1


def test_rollup_orders_children_before_parents():
    entries = [("/d/a.txt", 3), ("/d/sub/b.txt", 2), ("/d/sub/deep/c.txt", 1)]
    assert rollup(entries, "/d", a=True, max_depth=None) == [
        ("/d/a.txt", 3),
        ("/d/sub/b.txt", 2),
        ("/d/sub/deep/c.txt", 1),
        ("/d/sub/deep", 1),
        ("/d/sub", 3),
    ]


def test_rollup_without_a_keeps_only_directories():
    entries = [("/d/a.txt", 3), ("/d/sub/b.txt", 2)]
    assert rollup(entries, "/d", a=False, max_depth=None) == [("/d/sub", 2)]


def test_rollup_totals_are_recursive():
    entries = [("/d/sub/b.txt", 2), ("/d/sub/deep/c.txt", 1)]
    rows = dict(rollup(entries, "/d", a=False, max_depth=None))
    assert rows["/d/sub"] == 3
    assert rows["/d/sub/deep"] == 1


def test_rollup_handles_a_root_mount():
    entries = [("/a.txt", 2), ("/sub/b.txt", 3)]
    assert rollup(entries, "/", a=False, max_depth=None) == [("/sub", 3)]


def test_to_virtual_prepends_the_mount_prefix():
    spec = _spec("/slack/channels", "channels")
    assert to_virtual([("/channels/general.jsonl", 7)],
                      spec) == [("/slack/channels/general.jsonl", 7)]


def test_to_virtual_is_a_no_op_at_the_root_mount():
    spec = _spec("/dir", "dir")
    assert to_virtual([("/dir/a.txt", 1)], spec) == [("/dir/a.txt", 1)]


def test_depth_counts_segments_below_the_base():
    assert _depth("/dir", "/dir") == 0
    assert _depth("/dir/a.txt", "/dir") == 1
    assert _depth("/dir/sub/b.txt", "/dir") == 2
