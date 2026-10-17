import pytest

from mirage import MountMode, Workspace
from mirage.commands.builtin.generic.du import (
    DuFlags,
    du,
    du_generic,
    rollup,
    to_virtual,
)
from mirage.commands.config import Context
from mirage.io.types import SizedRun
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

    out, io = await du_generic(
        [_spec("/data/nosuch", "nosuch")],
        [],
        Context(flags={"c": True}),
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


@pytest.mark.parametrize("cut,code", [(True, 1), (False, 0)])
@pytest.mark.asyncio
async def test_a_truncated_walk_warns_and_exits_one(cut, code):
    """GNU du prints what it accounted for, warns, and exits 1."""
    compute_size, compute_entries = _make_backend({"/dir/a.txt": 2})
    out = await du(
        [_spec("/dir", "dir")],
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=DuFlags(),
        truncated=lambda: cut,
    )
    assert out.stdout == b"2\t/dir\n"
    assert out.exit_code == code
    assert (b"incomplete" in out.stderr) is cut


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
    assert out.runs == [
        SizedRun((("/m/dir/a.txt", 2), ("/m/dir/s/b", 3)), ("/m/dir/e",))
    ]
    out = await du(
        paths,
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=DuFlags(s=True),
    )
    assert out.runs is None


def test_rollup_handles_a_root_mount():
    entries = [("/a.txt", 2), ("/sub/b.txt", 3)]
    assert rollup(entries, "/", a=False, max_depth=None) == [("/sub", 3)]


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
