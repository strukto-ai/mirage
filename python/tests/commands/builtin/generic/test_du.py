import pytest

from mirage import MountMode, Workspace
from mirage.commands.builtin.generic.du import (DuFlags, _depth, du,
                                                parse_depth, parse_flags,
                                                rollup, run_du, separate_total,
                                                to_virtual)
from mirage.commands.builtin.generic_bind import CommandIO, DuOps
from mirage.commands.errors import UsageError
from mirage.ops.types import LinkView, MountView
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.types import FileStat, FileType, PathSpec


async def _ok(value):
    return value


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
async def test_separate_dirs_excludes_subdirectory_sizes():
    """GNU -S: parent totals omit children that are directories."""
    tree = {"/dir/a.txt": 3, "/dir/sub/b.txt": 2, "/dir/sub/deep/c.txt": 1}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(S=True))
    assert out.stdout == b"1\t/dir/sub/deep\n2\t/dir/sub\n3\t/dir\n"


@pytest.mark.asyncio
async def test_separate_dirs_with_summarize_uses_direct_files_only():
    tree = {"/dir/a.txt": 3, "/dir/sub/b.txt": 2, "/dir/sub/deep/c.txt": 1}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(s=True, S=True))
    assert out.stdout == b"3\t/dir\n"


@pytest.mark.asyncio
async def test_separate_dirs_with_all_lists_files():
    tree = {"/dir/a.txt": 3, "/dir/sub/b.txt": 2, "/dir/sub/deep/c.txt": 1}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(a=True, S=True))
    assert out.stdout == (b"3\t/dir/a.txt\n"
                          b"2\t/dir/sub/b.txt\n"
                          b"1\t/dir/sub/deep/c.txt\n"
                          b"1\t/dir/sub/deep\n"
                          b"2\t/dir/sub\n"
                          b"3\t/dir\n")


@pytest.mark.asyncio
async def test_separate_dirs_keeps_the_grand_total_recursive():
    """GNU -Sc: rows are separate, the total is not (coreutils 9.7)."""
    tree = {"/dir/a.txt": 3, "/dir/sub/b.txt": 2, "/dir/sub/deep/c.txt": 1}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(c=True, S=True))
    assert out.stdout == (b"1\t/dir/sub/deep\n"
                          b"2\t/dir/sub\n"
                          b"3\t/dir\n"
                          b"6\ttotal\n")


@pytest.mark.asyncio
async def test_separate_dirs_summarize_still_totals_recursively():
    tree = {"/dir/a.txt": 3, "/dir/sub/b.txt": 2, "/dir/sub/deep/c.txt": 1}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(s=True, c=True, S=True))
    assert out.stdout == b"3\t/dir\n6\ttotal\n"


@pytest.mark.asyncio
async def test_separate_dirs_keeps_a_file_operand_in_the_total():
    """GNU scopes -S to directories: a file operand counts itself."""
    compute_size, compute_entries = _make_backend({"/f.txt": 7})
    out = await du([_spec("/f.txt", "f.txt")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(c=True, S=True))
    assert out.stdout == b"7\t/f.txt\n7\ttotal\n"


def test_separate_total_sums_direct_children_only():
    entries = [("/d/a.txt", 3), ("/d/sub/b.txt", 2), ("/d/sub/deep/c.txt", 1)]
    assert separate_total(entries, "/d") == 3


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


def test_native_du_is_all_or_nothing():
    """Half a native du is unconstructable, so it cannot be wired.

    A backend offering only the cheaper ``size`` used to degrade du to
    one operand line with no directory rows and an inert ``-a``. Pairing
    the two halves in ``DuOps`` makes that shape unreachable (#645).
    """
    with pytest.raises(TypeError):
        DuOps(size=lambda *_a, **_k: None)
    with pytest.raises(TypeError):
        DuOps(entries=lambda *_a, **_k: None)


def test_command_io_omitting_du_keeps_the_walk_fallback():
    """No native du means the generic walk, never the degraded path."""
    assert CommandIO.__dataclass_fields__["du"].default is None
    assert "du_size" not in CommandIO.__dataclass_fields__
    assert "du_entries" not in CommandIO.__dataclass_fields__


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
async def test_s_with_max_depth_zero_warns_but_succeeds():
    """GNU: -s and --max-depth=0 are the same request, so it warns only."""
    compute_size, compute_entries = _make_backend({"/dir/a.txt": 2})
    flags = parse_flags(s=True, a=False, h=False, c=False, max_depth="0")
    out = await du([_spec("/dir", "dir")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=flags)
    assert out.stdout == b"2\t/dir\n"
    assert out.stderr == (
        b"du: warning: summarizing is the same as using --max-depth=0\n")
    assert out.exit_code == 0


def test_s_with_a_nonzero_max_depth_is_still_a_usage_error():
    with pytest.raises(UsageError) as excinfo:
        parse_flags(s=True, a=False, h=False, c=False, max_depth="1")
    assert "summarizing conflicts with --max-depth=1" in str(excinfo.value)


@pytest.mark.asyncio
async def test_backend_error_on_the_content_probe_reads_as_missing():
    """A driver error probing an absent path must not replace GNU's line."""

    async def stat(path):
        raise FileNotFoundError(path.virtual)

    async def compute_size(path):
        raise RuntimeError("Graph API error 404 (itemNotFound)")

    async def compute_entries(path):
        raise RuntimeError("Graph API error 404 (itemNotFound)")

    out = await run_du([_spec("/data/nosuch", "nosuch")],
                       "/",
                       lambda targets: _ok(list(targets)),
                       stat,
                       compute_size,
                       compute_entries,
                       c=True)
    assert out.stdout == b"0\ttotal\n"
    assert out.stderr == (b"du: cannot access '/data/nosuch': "
                          b"No such file or directory\n")
    assert out.exit_code == 1


@pytest.mark.asyncio
async def test_namespace_only_directory_is_present_not_missing():
    """A directory that exists only above a nested mount is readable.

    The parent backend holds nothing at the operand and cannot: the
    content lives in the descendant's own resource. Both backend channels
    therefore come back empty, and only the dispatcher-backed probe knows
    the path is a directory.
    """
    compute_size, compute_entries = _make_backend({})

    async def stat(path):
        raise FileNotFoundError(path.virtual)

    async def stat_path(virtual: str) -> FileStat | None:
        return FileStat(name="empty", type=FileType.DIRECTORY)

    out = await run_du([_spec("/empty", "empty")],
                       "/",
                       lambda targets: _ok(list(targets)),
                       stat,
                       compute_size,
                       compute_entries,
                       stat_path=stat_path)
    assert out.stdout == b"0\t/empty\n"
    assert out.stderr == b""
    assert out.exit_code == 0


@pytest.mark.asyncio
async def test_stat_path_answering_none_still_reports_missing():
    """The probe is evidence of presence, never of absence on its own."""
    compute_size, compute_entries = _make_backend({})

    async def stat(path):
        raise FileNotFoundError(path.virtual)

    async def stat_path(virtual: str) -> FileStat | None:
        return None

    out = await run_du([_spec("/nope", "nope")],
                       "/",
                       lambda targets: _ok(list(targets)),
                       stat,
                       compute_size,
                       compute_entries,
                       stat_path=stat_path)
    assert out.stdout == b""
    assert out.stderr == (b"du: cannot access '/nope': "
                          b"No such file or directory\n")
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


def test_rollup_separate_dirs_counts_only_direct_files():
    """GNU -S: a directory omits subdirectory sizes (pinned coreutils 9.7)."""
    entries = [("/d/a.txt", 3), ("/d/sub/b.txt", 2), ("/d/sub/deep/c.txt", 1)]
    rows = dict(
        rollup(entries, "/d", a=False, max_depth=None, separate_dirs=True))
    assert rows["/d/sub/deep"] == 1
    assert rows["/d/sub"] == 2
    assert "/d/a.txt" not in rows


def test_rollup_separate_dirs_keeps_empty_ancestor_dirs():
    """A directory with only subdirs still prints, at size 0."""
    entries = [("/d/sub/deep/c.txt", 4)]
    rows = dict(
        rollup(entries, "/d", a=False, max_depth=None, separate_dirs=True))
    assert rows["/d/sub/deep"] == 4
    assert rows["/d/sub"] == 0


def test_rollup_a_keeps_the_sum_over_a_directory_marker():
    entries = [("/d/sub/deep/c.txt", 5), ("/d/sub/deep", 0)]
    rows = dict(rollup(entries, "/d", a=True, max_depth=None))
    assert rows["/d/sub/deep"] == 5


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


def _mounts_view(descendants: tuple[str, ...]) -> MountView:
    return MountView(
        descendants=lambda p:
        [d for d in descendants if d.startswith(p.rstrip("/") + "/")],
        is_root=lambda p: False,
        root_of=lambda p: "/")


async def _no_target_stat(path: str) -> FileStat | None:
    return None


async def _never_exists(path: str) -> bool:
    return False


def _links_view(links: dict[str, str]) -> LinkView:

    def stat_of(path: str) -> FileStat:
        target = links[path]
        return FileStat(name=path.rsplit("/", 1)[-1],
                        type=FileType.SYMLINK,
                        size=len(target))

    return LinkView(stat_at=lambda p: stat_of(p) if p in links else None,
                    children=lambda p: [],
                    subtree=lambda p: [(k, stat_of(k)) for k in sorted(links)
                                       if k.startswith(p.rstrip("/") + "/")],
                    resolve=lambda p: links.get(p, p),
                    exists=_never_exists,
                    target_stat=_no_target_stat)


# The nested-mount behavior is pinned against GNU coreutils 9.7 on
# debian:stable-slim (du --apparent-size -B1 over a tmpfs mounted inside
# the operand): a file shadowed by a mount appears nowhere and counts
# nowhere. The parent mount's own rows are GNU's `du -x` report; the
# descendant mount's block is appended by the executor fan-out.
@pytest.mark.asyncio
async def test_descendant_mount_rows_and_total_are_excluded():
    tree = {"/top.txt": 10, "/inner/leftover.txt": 1000}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/base", "")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(),
                   mounts=_mounts_view(("/base/inner", )))
    assert out.stdout == b"10\t/base\n"


@pytest.mark.asyncio
async def test_descendant_mount_leaves_are_excluded_under_a():
    tree = {"/top.txt": 10, "/inner/leftover.txt": 1000}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/base", "")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(a=True),
                   mounts=_mounts_view(("/base/inner", )))
    assert out.stdout == b"10\t/base/top.txt\n10\t/base\n"


@pytest.mark.asyncio
async def test_descendant_mount_bytes_are_excluded_under_s():
    tree = {"/top.txt": 10, "/inner/leftover.txt": 1000}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/base", "")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(s=True),
                   mounts=_mounts_view(("/base/inner", )))
    assert out.stdout == b"10\t/base\n"


@pytest.mark.asyncio
async def test_without_a_mount_view_shadowed_keys_still_count():
    """The opt-in is the mechanism: a caller that offers no view cannot
    know where the boundaries are, so the backend's keys all count."""
    tree = {"/top.txt": 10, "/inner/leftover.txt": 1000}
    compute_size, compute_entries = _make_backend(tree)
    out = await du([_spec("/base", "")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags())
    assert out.stdout == b"1000\t/base/inner\n1010\t/base\n"


@pytest.mark.asyncio
async def test_link_under_a_descendant_mount_is_not_counted():
    """A namespace link below the boundary belongs to the child's run."""
    compute_size, compute_entries = _make_backend({"/top.txt": 10})
    out = await du([_spec("/base", "")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(),
                   links=_links_view({
                       "/base/inner/lnk": "12345",
                       "/base/kept": "123",
                   }),
                   mounts=_mounts_view(("/base/inner", )))
    assert out.stdout == b"13\t/base\n"


@pytest.mark.asyncio
async def test_fully_shadowed_operand_reports_zero():
    """Backend holds only shadowed keys: the parent's own report is empty,
    never a compute_size fallback that would count the shadowed bytes."""
    compute_size, compute_entries = _make_backend(
        {"/inner/leftover.txt": 1000})
    out = await du([_spec("/base", "")],
                   compute_size=compute_size,
                   compute_entries=compute_entries,
                   flags=DuFlags(),
                   mounts=_mounts_view(("/base/inner", )))
    assert out.stdout == b"0\t/base\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("flag", ["-S", "--separate-dirs"])
async def test_du_separate_dirs_off_the_command_line(tmp_path, flag):
    res = DiskResource(root=str(tmp_path))
    ws = Workspace({"/d": res}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /d/sub/deep")
    await ws.execute("printf abc > /d/a.txt")
    await ws.execute("printf de > /d/sub/b.txt")
    await ws.execute("printf f > /d/sub/deep/c.txt")
    result = await ws.execute(f"du {flag} -c /d")
    assert result.exit_code == 0
    assert await result.stdout_str() == ("1\t/d/sub/deep\n"
                                         "2\t/d/sub\n"
                                         "3\t/d\n"
                                         "6\ttotal\n")
    await ws.close()


@pytest.mark.asyncio
async def test_du_missing_operand_reports_and_exits_1(tmp_path):
    # GNU: "du: cannot access 'X': No such file or directory", exit 1. Walking
    # a missing operand used to report it as size 0 with exit 0.
    res = DiskResource(root=str(tmp_path))
    ws = Workspace({"/d": res}, mode=MountMode.WRITE)
    result = await ws.execute("du /d/__nf_missing__")
    assert result.exit_code == 1
    assert await result.stdout_str() == ""
    assert (await result.stderr_str()) == (
        "du: cannot access '/d/__nf_missing__': No such file or directory\n")
    await ws.close()


@pytest.mark.asyncio
async def test_du_partial_operands_keeps_present_output(tmp_path):
    res = DiskResource(root=str(tmp_path))
    ws = Workspace({"/d": res}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /d/sub")
    result = await ws.execute("du /d/sub /d/__nf_missing__")
    assert result.exit_code == 1
    assert "/d/sub" in await result.stdout_str()
    assert "__nf_missing__" in await result.stderr_str()
    await ws.close()


@pytest.mark.asyncio
async def test_du_on_the_implied_parent_of_a_nested_mount():
    # GNU coreutils 9.7 on debian:stable-slim, tmpfs mounted at /empty/hole:
    # `du --apparent-size -B1 /empty` prints both rows and exits 0. The
    # absence line is reserved for a path that is really not there.
    ws = Workspace({
        "/": RAMResource(),
        "/empty/hole": RAMResource()
    },
                   mode=MountMode.WRITE)
    ws.create_session("s")
    result = await ws.execute("du /empty", session_id="s")
    assert await result.stdout_str() == "0\t/empty/hole\n0\t/empty\n"
    assert await result.stderr_str() == ""
    assert result.exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_du_on_the_implied_parent_of_a_nested_mount_under_s():
    ws = Workspace({
        "/": RAMResource(),
        "/empty/hole": RAMResource()
    },
                   mode=MountMode.WRITE)
    ws.create_session("s")
    result = await ws.execute("du -s /empty", session_id="s")
    assert await result.stdout_str() == "0\t/empty\n"
    assert await result.stderr_str() == ""
    assert result.exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_du_on_a_directory_implied_only_by_a_link_below_it():
    """The same false absence, with no descendant mount in sight.

    ``namespace_names`` synthesizes a directory for a link's ancestors
    too, so the mount table alone is not enough evidence; the probe that
    answers here is the one that asks the namespace as a whole.
    """
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    ws.create_session("s")
    await ws.execute("mkdir -p /real", session_id="s")
    await ws.execute("echo hi > /real/f.txt", session_id="s")
    await ws.execute("ln -s /real/f.txt /ghost/deep/lnk", session_id="s")
    result = await ws.execute("du /ghost", session_id="s")
    assert await result.stderr_str() == ""
    assert result.exit_code == 0
    assert "/ghost" in await result.stdout_str()
    await ws.close()


@pytest.mark.asyncio
async def test_du_still_reports_absence_when_the_descendant_is_ungranted():
    """A session that may not see the mount must not learn it is there.

    ``registry.descendant_mounts`` is not session-filtered, so proving
    presence from the mount table alone would answer ``0 /empty`` here and
    confirm a walled-off mount's parent. The dispatcher-backed probe is
    filtered, so absence stays the answer.
    """
    ws = Workspace({
        "/": RAMResource(),
        "/empty/hole": RAMResource()
    },
                   mode=MountMode.WRITE)
    ws.create_session("scoped", {"/": "rw"})
    result = await ws.execute("du /empty", session_id="scoped")
    assert await result.stdout_str() == ""
    assert (await result.stderr_str()) == (
        "du: cannot access '/empty': No such file or directory\n")
    assert result.exit_code == 1
    await ws.close()
