import pytest

from mirage import MountMode, Workspace
from mirage.commands.builtin.generic.du import (
    DuFlags,
    du,
    du_generic,
    excluded,
    excluded_start,
    inode_count,
    newest_under,
    parse_flags,
    rollup,
    to_virtual,
)
from mirage.commands.config import Context
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.view.types import MountView


async def _ok(value):
    return value


def _spec(virtual: str, vfs_path: str, raw_path: str | None = None):
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path=vfs_path,
        raw_path=raw_path,
    )


def _make_backend(tree: dict[str, int]):
    """Build (compute_size, compute_entries) over an in-memory tree.

    ``tree`` maps mount-relative paths to sizes, which is the domain every
    backend reports in.

    Args:
        tree (dict[str, int]): mount-relative path -> byte size.
    """

    async def compute_size(p: PathSpec) -> int:
        base = p.mount_path.rstrip("/")
        return sum(
            size
            for path, size in tree.items()
            if path == base or path.startswith(base + "/")
        )

    async def compute_entries(
        p: PathSpec,
    ) -> tuple[list[tuple[str, int]], int]:
        base = p.mount_path.rstrip("/")
        found = sorted(
            (path, size)
            for path, size in tree.items()
            if path == base or path.startswith(base + "/")
        )
        return found, sum(size for _, size in found)

    return compute_size, compute_entries


@pytest.mark.asyncio
async def test_backend_error_on_the_content_probe_reads_as_missing():
    """A driver error probing an absent path must not replace GNU's line."""

    async def stat(path):
        raise FileNotFoundError(path.virtual)

    async def compute_size(path):
        raise RuntimeError("Graph API error 404 (itemNotFound)")

    async def compute_entries(path):
        raise RuntimeError("Graph API error 404 (itemNotFound)")

    ctx = Context(flags={"total": True})
    flags = parse_flags(ctx)
    assert not isinstance(flags, IOResult)
    out, io = await du_generic(
        flags,
        [_spec("/data/nosuch", "nosuch")],
        [],
        ctx,
        lambda targets: _ok(list(targets)),
        stat,
        compute_size,
        compute_entries,
    )
    assert out == b"0\ttotal\n"
    assert io.stderr == (
        b"du: cannot access '/data/nosuch': No such file or directory\n"
    )
    assert io.exit_code == 1


@pytest.mark.parametrize(
    "stopped,code,err",
    [
        (
            ["/dir: stopped after 1 files (walk_limit); narrow the path"],
            1,
            b"du: /dir: stopped after 1 files (walk_limit); narrow the path\n",
        ),
        ([], 0, b""),
    ],
)
@pytest.mark.asyncio
async def test_a_walk_cut_short_says_where_and_exits_one(stopped, code, err):
    """du prints what it accounted for, says where it stopped, exits 1."""
    compute_size, compute_entries = _make_backend({"/dir/a.txt": 2})
    out = await du(
        [_spec("/dir", "dir")],
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=DuFlags(),
        stopped=lambda: stopped,
    )
    assert out.stdout == b"2\t/dir\n"
    assert out.exit_code == code
    assert out.stderr == err


@pytest.mark.asyncio
async def test_du_reports_what_it_measured_unless_it_only_summed():
    compute_size, compute_entries = _make_backend(
        {"/dir/a.txt": 2, "/dir/s/b": 3}
    )
    paths = [_spec("/m/dir", "dir")]
    out = await du(
        paths,
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=DuFlags(),
        directories=lambda: ["/m/dir/e"],
    )
    assert [(r.path.virtual, r.run, r.size) for r in out.records] == [
        ("/m/dir", 0, None),
        ("/m/dir/a.txt", 0, 2),
        ("/m/dir/s/b", 0, 3),
        ("/m/dir/e", 0, None),
    ]
    out = await du(
        paths,
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=DuFlags(s=True),
    )
    assert out.records is None


def test_rollup_handles_a_root_mount():
    entries = [("/a.txt", 2), ("/sub/b.txt", 3)]
    assert rollup(entries, "/", a=False, max_depth=None) == [("/sub", 3)]


# An --exclude pattern matches the path as du prints it, or
# the part after any slash, with `*` crossing slashes and case kept
# (pinned on debian:stable-slim). Mirrored in du.test.ts.
def test_an_exclude_matches_the_path_or_a_part_after_a_slash():
    assert excluded(["b"], "d/x/b")
    assert excluded(["x/b"], "d/x/b")
    assert excluded(["d*b"], "d/x/b")
    assert not excluded(["x"], "d/x/b")
    assert not excluded(["B"], "d/x/b")
    assert not excluded([], "d")


def test_a_mount_under_an_excluded_directory_is_no_start():
    operand = _spec("/a", "a")
    assert excluded_start(["skip"], operand, _spec("/a/skip/inner", ""))
    assert excluded_start(["inner"], operand, _spec("/a/skip/inner", ""))
    assert not excluded_start(["skip"], operand, _spec("/a/keep/in", ""))
    assert not excluded_start(["a"], operand, _spec("/a/keep/in", ""))
    assert not excluded_start([], operand, _spec("/a/skip/inner", ""))
    dot = _spec("/data", "data", ".")
    assert excluded_start(["./sub"], dot, _spec("/data/sub/m", ""))
    assert excluded_start(["sub"], _spec("/", ""), _spec("/sub/m", ""))


@pytest.mark.asyncio
async def test_a_time_format_keeps_the_stamp_nanoseconds():
    compute_size, compute_entries = _make_backend({"/dir/f": 1})
    parsed = parse_flags(
        Context(flags={"time": True}, env={"TIME_STYLE": "+%s.%N"})
    )
    assert isinstance(parsed, DuFlags)
    out = await du(
        [_spec("/dir", "dir")],
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=parsed,
        times=lambda: {"/dir/f": "1970-01-01T00:00:01.123456789+00:00"},
    )
    assert out.stdout.decode() == "1\t1.123456789\t/dir\n"


def test_inodes_count_each_directory_and_under_s_its_own_files():
    leaves = [("/d/a", 1), ("/d/x/b", 1), ("/d/x/bb", 1)]
    dirs = ["/d/x/z"]
    assert rollup(
        leaves, "/d", a=False, max_depth=None, dirs=dirs, inodes=True
    ) == [("/d/x/z", 1), ("/d/x", 4)]
    assert rollup(
        leaves,
        "/d",
        a=False,
        max_depth=None,
        dirs=dirs,
        separate_dirs=True,
        inodes=True,
    ) == [("/d/x/z", 1), ("/d/x", 3)]
    assert inode_count(leaves, "/d", dirs) == 6


def test_a_directory_shows_the_newest_time_in_its_tree():
    late = "2024-03-04T05:06:07.5"
    newest = newest_under(
        {
            "/d": "2023-01-01T00:00:00",
            "/d/x/b": late,
            "/d/a": "2024-01-02T03:04:05",
            "/e/f": "2030-01-01T00:00:00",
        },
        "/d",
    )
    assert newest["/d"][1] == newest["/d/x"][1] == late
    assert "/e/f" not in newest


def test_to_virtual_is_a_no_op_at_the_root_mount():
    spec = _spec("/dir", "dir")
    assert to_virtual([("/dir/a.txt", 1)], spec) == [("/dir/a.txt", 1)]


def _mounts_view(descendants: tuple[str, ...]) -> MountView:
    visible = [d for d in descendants if not d.endswith("/hidden")]
    return MountView(
        descendants=lambda p: [
            d for d in descendants if d.startswith(p.rstrip("/") + "/")
        ],
        visible_descendants=lambda p: [
            d for d in visible if d.startswith(p.rstrip("/") + "/")
        ],
        is_root=lambda p: False,
        root_of=lambda p: "/",
    )


# The nested-mount behavior is pinned against GNU coreutils 9.7 on
# debian:stable-slim (du --apparent-size -B1 over a tmpfs mounted inside
# the operand): a file shadowed by a mount appears nowhere and counts
# nowhere. The parent mount's own rows are GNU's `du -x` report; the
# descendant mount's block is appended by the executor fan-out.
@pytest.mark.parametrize(
    "tree,flags,expected",
    [
        (
            {"/top.txt": 10, "/inner/leftover.txt": 1000},
            DuFlags(),
            b"10\t/base\n",
        ),
        (
            {"/top.txt": 10, "/inner/leftover.txt": 1000},
            DuFlags(a=True),
            b"10\t/base/top.txt\n10\t/base\n",
        ),
        (
            {"/top.txt": 10, "/inner/leftover.txt": 1000},
            DuFlags(s=True),
            b"10\t/base\n",
        ),
        ({"/inner/leftover.txt": 1000}, DuFlags(), b"0\t/base\n"),
    ],
)
@pytest.mark.asyncio
async def test_descendant_mount_is_excluded(tree, flags, expected):
    compute_size, compute_entries = _make_backend(tree)
    out = await du(
        [_spec("/base", "")],
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=flags,
        mounts=_mounts_view(("/base/inner",)),
    )
    assert out.stdout == expected


@pytest.mark.asyncio
async def test_without_a_mount_view_shadowed_keys_still_count():
    """The opt-in is the mechanism: a caller that offers no view cannot
    know where the boundaries are, so the backend's keys all count."""
    tree = {"/top.txt": 10, "/inner/leftover.txt": 1000}
    compute_size, compute_entries = _make_backend(tree)
    out = await du(
        [_spec("/base", "")],
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=DuFlags(),
    )
    assert out.stdout == b"1000\t/base/inner\n1010\t/base\n"


@pytest.mark.asyncio
async def test_du_on_a_directory_implied_only_by_a_link_below_it():
    """The same false absence, with no descendant mount in sight.

    ``namespace_names`` synthesizes a directory for a link's ancestors
    too, so the mount table alone is not enough evidence; the probe that
    answers here is the one that asks the namespace as a whole. ``ln``
    refuses a link under an absent directory, so the link is seeded the
    way a node table restored from an older snapshot holds one.
    """
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    ws.create_session("s")
    await ws.shell("mkdir -p /real", session_id="s")
    await ws.shell("echo hi > /real/f.txt", session_id="s")
    await ws.namespace.symlink("/ghost/deep/lnk", "/real/f.txt", 0.0)
    result = await ws.shell("du /ghost", session_id="s")
    assert await result.stderr_str() == ""
    assert result.exit_code == 0
    assert "/ghost" in await result.stdout_str()
    await ws.close()


@pytest.mark.asyncio
async def test_du_names_a_directory_the_walk_could_not_open():
    # GNU: "du: cannot read directory 'X': Permission denied", the rest
    # still counted, exit 1; spelled as the operand was typed, after the
    # unreadable-operand lines, which are known before any walk.
    compute_size, compute_entries = _make_backend({"/t/open/o": 2})
    out = await du(
        [_spec("/d/t", "t", raw_path="t")],
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=DuFlags(),
        missing=(("gone", "No such file or directory"),),
        unreadable=lambda: ["/d/t/sealed"],
    )
    assert out.stdout == b"2\tt/open\n2\tt\n"
    assert out.stderr == (
        b"du: cannot access 'gone': No such file or directory\n"
        b"du: cannot read directory 't/sealed': Permission denied\n"
    )
    assert out.exit_code == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "options,expected",
    [
        ("-b", "6"),
        ("--bytes", "6"),
        ("--apparent-size", "6"),
        ("-k", "1"),
        ("-m", "1"),
        ("-B1", "6"),
        ("--block-size=K", "1K"),
        ("-BKB", "1kB"),
        ("-BKiB", "1KiB"),
        ("-b -k", "1"),
        ("-k -b", "6"),
        ("-k -b -k", "1"),
        ("-bkb", "6"),
        ("-B1 -h -B1024", "1"),
        ("-k --human-readable", "6"),
        ("--summarize --bytes", "6"),
        ("--dereference --no-dereference --bytes", "6"),
    ],
)
async def test_du_gnu_units_and_long_aliases(options, expected):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("printf abcdef > /data/f")
        result = await ws.shell(f"du {options} /data/f")
        assert result.exit_code == 0
        assert await result.stderr_str() == ""
        assert await result.stdout_str() == f"{expected}\t/data/f\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_du_rounds_rows_after_summing_and_keeps_byte_records():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell(
            "mkdir /data/d; printf a > /data/d/a; printf b > /data/d/b"
        )
        result = await ws.shell("du --all --total -B4 /data/d")
        assert result.exit_code == 0
        assert await result.stdout_str() == (
            "1\t/data/d/a\n1\t/data/d/b\n1\t/data/d\n1\ttotal\n"
        )
        for size, count in [(0, 0), (1024, 1), (1025, 2)]:
            await ws.shell(
                f"printf '%{size}s' x > /data/f" if size else ": > /data/f"
            )
            result = await ws.shell("du -k /data/f")
            assert await result.stdout_str() == f"{count}\t/data/f\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_du_orders_human_units_and_validates_each_block_size():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("printf '%1025s' x > /data/f")
        for options, expected in [
            ("-k -h", "1.1K"),
            ("-h -k", "2"),
            ("-B0x10", "65"),
            ("-B010", "129"),
        ]:
            result = await ws.shell(f"du {options} /data/f")
            assert result.exit_code == 0
            assert await result.stdout_str() == f"{expected}\t/data/f\n"
        result = await ws.shell("du -B0 -b /data/f")
        assert result.exit_code == 1
        assert await result.stderr_str() == "du: invalid -B argument '0'\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_du_long_link_aliases_keep_last_option_order():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell(
            "printf abcdef > /data/target; ln -s /data/target /data/link"
        )
        for options, expected in [
            ("--no-dereference --dereference", "6"),
            ("--dereference --no-dereference", "12"),
            ("-L --no-dereference --dereference", "6"),
        ]:
            result = await ws.shell(f"du --bytes {options} /data/link")
            assert result.exit_code == 0
            assert await result.stdout_str() == f"{expected}\t/data/link\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "unit,expected",
    [("3", "6004799503160662"), ("18014398509481983", "2")],
)
async def test_du_large_byte_totals_keep_exact_units(unit, expected):
    total = 18014398509481984
    compute_size, compute_entries = _make_backend({"/dir/f": total})
    parsed = parse_flags(
        Context(flags={"block_size": unit, "all": True, "total": True})
    )
    assert isinstance(parsed, DuFlags)
    out = await du(
        [_spec("/dir", "dir")],
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=parsed,
    )
    assert out.stdout.decode() == (
        f"{expected}\t/dir/f\n{expected}\t/dir\n{expected}\ttotal\n"
    )
    assert out.stderr == b""
    assert out.exit_code == 0
    assert out.records is not None
    assert [record.size for record in out.records] == [None, total]


@pytest.mark.asyncio
async def test_an_earlier_operand_leaves_no_time_in_a_later_one():
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell(
            "printf x > /d/skip; touch -d '2030-01-01' /d/skip;"
            " printf y > /d/keep; touch -d '2020-01-01' /d/keep"
        )
        result = await ws.shell(
            "cd /; du --time --time-style=+%Y --exclude=/d/skip d/skip /d"
        )
        rows = (await result.stdout_str()).splitlines()
        assert rows[0].split("\t")[1:] == ["2030", "d/skip"]
        assert rows[-1].endswith("\t/d")
        assert "2030" not in rows[-1]
    finally:
        await ws.close()
