from functools import partial

import pytest

from mirage.commands.builtin.generic.stat import stat
from mirage.doors.types import LinkView
from mirage.io.types import materialize
from mirage.types import (
    DEVICE_NUMBERS_KEY,
    LINK_TARGET_KEY,
    CapacityResult,
    CapacityState,
    ContentType,
    FileStat,
    FileType,
    MountMode,
    PathSpec,
)
from mirage.utils.stat_view import DIR_SIZE
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

_MTIME = "2026-01-02T15:30:45Z"
_MTIME_SHOWN = "2026-01-02 15:30:45.000000000 +0000"
_MTIME_EPOCH = "1767367845"


class _OverlayRAMVFS(RAMVFS):
    """RAM VFS with native setattr stripped, standing in for an API
    backend whose chmod/chown/touch live only in the namespace overlay."""

    setattr = BaseVFS.setattr


def _fs(**kw: object) -> FileStat:
    base: dict[str, object] = dict(
        name="f.txt",
        size=6,
        modified=_MTIME,
        type=FileType.FILE,
        content=ContentType.TEXT,
    )
    base.update(kw)
    if base.get("type") is not FileType.FILE and "content" not in kw:
        base.pop("content", None)
    return FileStat(**base)


async def _const_stat(fs: FileStat, _p: PathSpec) -> FileStat:
    return fs


async def _render(fmt: str, fs: FileStat) -> str:
    out, io = await stat(
        [PathSpec.from_str_path("/data/f.txt")],
        stat_fn=partial(_const_stat, fs),
        c=fmt,
    )
    assert io.exit_code == 0
    return (await materialize(out)).decode().rstrip("\n")


async def _render_named(fmt: str, name: str) -> str:
    """Render one directive for an operand typed as ``name``.

    Args:
        fmt (str): the format string.
        name (str): the operand, kept verbatim for %n and %N.
    """
    out, io = await stat(
        [PathSpec.from_str_path(name)],
        stat_fn=partial(_const_stat, _fs()),
        c=fmt,
    )
    assert io.exit_code == 0
    return (await materialize(out)).decode().rstrip("\n")


async def _run(ws: Workspace, cmd: str) -> tuple[int, str, str]:
    r = await ws.shell(cmd)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


@pytest.mark.asyncio
async def test_default_record_sizes_a_directory_as_percent_s_does():
    # A directory is DIR_SIZE whatever the backend put in size: None for
    # a synthetic one, a subtree total for a Graph folder. A file keeps
    # its own size, None when unknown.
    cases = [
        (_fs(type=FileType.DIRECTORY, size=None), f"  Size: {DIR_SIZE} "),
        (_fs(type=FileType.DIRECTORY, size=123456), f"  Size: {DIR_SIZE} "),
        (_fs(size=None), "  Size: - "),
    ]
    for fs, want in cases:
        out, io = await stat(
            [PathSpec.from_str_path("/data/f.txt")],
            stat_fn=partial(_const_stat, fs),
        )
        assert io.exit_code == 0
        assert want in (await materialize(out)).decode()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fs,want",
    [
        # No mode is GNU's 0644 file default, as ls -l falls back to.
        (_fs(mode=None), "644 -rw-r--r-- 81a4"),
        # A special bit keeps the high octal digit and renders as s/S/t/T.
        (_fs(mode=0o4644), "4644 -rwSr--r-- 89a4"),
        (
            _fs(type=FileType.DIRECTORY, size=None, mode=None),
            "755 drwxr-xr-x 41ed",
        ),
    ],
)
async def test_mode_directives(fs, want):
    assert await _render("%a %A %f", fs) == want


@pytest.mark.asyncio
async def test_printf_flags_width_precision():
    # The flag/width prefix must not be mistaken for the directive char.
    assert await _render("%04a", _fs(mode=0o644)) == "0644"
    assert await _render("%#a", _fs(mode=0o4755)) == "04755"
    assert await _render("%-8a|", _fs(mode=0o4755)) == "4755    |"
    assert await _render("%6s", _fs(size=1)) == "     1"
    assert await _render("%-6s|", _fs(size=1)) == "1     |"
    # width applies to the sentinel too; precision truncates string values.
    assert await _render("%5i", _fs()) == "    ?"
    assert await _render("%.3F", _fs()) == "reg"


# Pinned against GNU coreutils 9.7 on debian:stable-slim under LC_ALL=C.
# Single quotes are the rule; a name whose only awkward character is an
# apostrophe reads better in double quotes and GNU renders that one case
# that way, but any other shell character (or an unprintable one, a byte
# past ASCII included) sends it back to single quotes.
_GNU_QUOTED = [
    ("a'b", '"a\'b"'),
    ("a'b$c", "'a'\\''b$c'"),
    ("a\tb", "'a'$'\\t''b'"),
    # A leading escape keeps the empty quotes; a trailing one does not.
    ("\ta", "''$'\\t''a'"),
    ("café", "'caf'$'\\303\\251'"),
    ("a'béc", "'a'\\''b'$'\\303\\251''c'"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,quoted", _GNU_QUOTED)
async def test_quoted_name_is_shell_safe(name: str, quoted: str):
    assert await _render_named("%N", name) == quoted


@pytest.mark.asyncio
async def test_a_link_target_is_quoted_by_the_same_rule():
    """The target is a second field, so it gets its own quoting."""
    assert (
        await _render("%N", _link_fs("a'b$c"))
        == "'/data/f.txt' -> 'a'\\''b$c'"
    )
    assert await _render("%N", _link_fs("a'b")) == "'/data/f.txt' -> \"a'b\""
    assert (
        await _render("%N", _link_fs("a\tb"))
        == "'/data/f.txt' -> 'a'$'\\t''b'"
    )


@pytest.mark.asyncio
async def test_owner_directives():
    owned = _fs(uid=1000, gid="dev")
    assert await _render("%u", owned) == "1000"
    assert await _render("%U", owned) == "1000"
    assert await _render("%g", owned) == "dev"
    assert await _render("%G", owned) == "dev"
    # No owner and no identity -> `-` in every slot (matches ls -l).
    bare = _fs(uid=None, gid=None)
    assert await _render("%u %U %g %G", bare) == "- - - -"


@pytest.mark.asyncio
async def test_time_directives():
    fs = _fs(modified=_MTIME, ctime=_MTIME, atime="2026-03-04T05:06:07Z")
    assert await _render("%y", fs) == _MTIME_SHOWN
    assert await _render("%Y", fs) == _MTIME_EPOCH
    assert await _render("%z", fs) == _MTIME_SHOWN
    assert await _render("%Z", fs) == _MTIME_EPOCH
    assert await _render("%x", fs) == "2026-03-04 05:06:07.000000000 +0000"
    assert await _render("%X", fs) == "1772600767"


@pytest.mark.asyncio
async def test_atime_falls_back_to_mtime():
    fs = _fs(modified=_MTIME, atime=None)
    assert await _render("%x", fs) == _MTIME_SHOWN
    assert await _render("%X", fs) == _MTIME_EPOCH


@pytest.mark.asyncio
async def test_structural_constants():
    fs = _fs()
    assert await _render("%B", fs) == "512"
    # A regular file has no device identity.
    assert await _render("%r %R %t %T", fs) == "0 0 0 0"


@pytest.mark.asyncio
async def test_character_device_number_directives():
    fs = _fs(type=FileType.CHAR_DEVICE, extra={DEVICE_NUMBERS_KEY: (1, 3)})
    assert await _render("%r %R %t %T %Hr %Lr", fs) == "259 103 1 3 1 3"


@pytest.mark.asyncio
async def test_unbacked_directives_render_question_mark():
    fs = _fs()
    for spec in ("%i", "%d", "%D", "%h", "%b", "%o", "%m", "%C"):
        assert await _render(spec, fs) == "?", spec


@pytest.mark.asyncio
async def test_literal_percent_and_unknown_and_text():
    assert await _render("100%%", _fs()) == "100%"
    assert await _render("%q", _fs()) == "?"
    assert (
        await _render("size=%s type=%F", _fs(size=6))
        == "size=6 type=regular file"
    )


@pytest.mark.asyncio
async def test_long_incomplete_directive_is_linear():
    fmt = "%" + "0" * 10_000 + "!"
    assert await _render(fmt, _fs()) == "?"


@pytest.mark.asyncio
async def test_missing_operand_raises():
    with pytest.raises(ValueError, match="missing operand"):
        await stat([], stat_fn=partial(_const_stat, _fs()), c="%n")


async def _quota_fs(_p: PathSpec) -> tuple[str, CapacityResult]:
    return "disk", CapacityResult(
        state=CapacityState.QUOTA,
        total=40960,
        used=16384,
        available=12288,
        inodes=100,
        inodes_used=40,
        inodes_free=50,
    )


@pytest.mark.asyncio
async def test_f_counts_a_quota_in_1k_blocks():
    out, io = await stat(
        [PathSpec.from_str_path("/data/f.txt")],
        stat_fn=partial(_const_stat, _fs()),
        c="%T %S %b %f %a %c %d %i %5l|",
        f=True,
        statfs=_quota_fs,
    )
    assert io.exit_code == 0
    assert (
        await materialize(out)
    ).decode() == "disk 1024 40 24 12 100 60 ?     ?|\n"


@pytest.mark.asyncio
async def test_f_without_a_workspace_knows_no_file_system():
    out, io = await stat(
        [PathSpec.from_str_path("/data/f.txt")],
        stat_fn=partial(_const_stat, _fs()),
        c="%n %T %b %05c",
        f=True,
    )
    assert (await materialize(out)).decode() == "/data/f.txt - -     -\n"


@pytest.mark.asyncio
async def test_stat_reflects_overlay_chmod_chown():
    vfs = _OverlayRAMVFS()
    vfs._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    await _run(ws, "chmod 600 /data/f.txt")
    await _run(ws, "chown 501:staff /data/f.txt")
    code, out, _ = await _run(ws, 'stat -c "%a %u %g" /data/f.txt')
    assert code == 0
    assert out == "600 501 staff\n"


@pytest.mark.asyncio
async def test_owner_defaults_to_workspace_agent():
    vfs = RAMVFS()
    vfs._store.files["/f.txt"] = b"hello"
    ws = Workspace(
        {"/data/": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        agent_id="agent7",
    )
    code, out, _ = await _run(ws, 'stat -c "%U:%G" /data/f.txt')
    assert code == 0
    # The owner is the workspace user; the group is the session's
    # profile, and this session runs under none.
    assert out == "agent7:-\n"


@pytest.mark.asyncio
async def test_owner_falls_back_to_dash_when_unclaimed():
    vfs = RAMVFS()
    vfs._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    code, out, _ = await _run(ws, 'stat -c "%U:%G" /data/f.txt')
    assert code == 0
    assert out == "-:-\n"


def _link_fs(target: str = "/data/f.txt") -> FileStat:
    return FileStat(
        name="link",
        size=len(target.encode()),
        modified=_MTIME,
        type=FileType.SYMLINK,
        extra={LINK_TARGET_KEY: target},
    )


def _link_lookup(virtual: str) -> FileStat | None:
    return _link_fs() if virtual.endswith("link") else None


async def _always_exists(virtual: str) -> bool:
    return True


async def _no_target(virtual: str) -> FileStat | None:
    return None


_LINKS = LinkView(
    stat_at=_link_lookup,
    children=lambda directory: [],
    subtree=lambda directory: [],
    resolve=lambda virtual: virtual,
    exists=_always_exists,
    target_stat=_no_target,
)


@pytest.mark.asyncio
async def test_dash_l_dereferences_instead_of_reporting_the_link():
    out, io = await stat(
        [PathSpec.from_str_path("/data/link")],
        stat_fn=partial(_const_stat, _fs()),
        links=_LINKS,
        L=True,
    )
    assert io.exit_code == 0
    text = (await materialize(out)).decode()
    assert "  File: /data/link\n" in text
    assert "regular file" in text


@pytest.mark.asyncio
async def test_format_directives_describe_a_link_as_gnu_does():
    """%F names the type, %A the mode string, %f the type bits."""
    assert await _render("%F", _link_fs()) == "symbolic link"
    assert await _render("%A", _link_fs()) == "lrwxrwxrwx"
    assert (await _render("%f", _link_fs())) == "a1ff"


@pytest.mark.asyncio
async def test_link_size_is_the_target_string_length():
    assert await _render("%s", _link_fs("/a/very/long/target")) == str(
        len("/a/very/long/target")
    )


@pytest.mark.asyncio
async def test_default_stat_layout_and_unknown_metadata():
    info = _fs(size=None, modified=None, ctime=None)
    out, io = await stat(
        [PathSpec.from_str_path("/data/f.txt")],
        stat_fn=partial(_const_stat, info),
    )
    assert io.exit_code == 0
    assert (await materialize(out)).decode() == (
        "  File: /data/f.txt\n"
        "  Size: -         \tBlocks: ?          "
        "IO Block: ?      regular file\n"
        "Device: ?\tInode: ?           Links: ?\n"
        "Access: (0644/-rw-r--r--)  Uid: (    -/       -)   "
        "Gid: (    -/       -)\n"
        "Access: -\nModify: -\nChange: -\n Birth: -\n"
    )
    assert await _render("%z %Z %w %W", info) == "- 0 - 0"
    info = _fs(ctime="2026-03-04T05:06:07Z", birthtime=_MTIME)
    assert (
        await _render("%z %Z %w %W", info)
        == "2026-03-04 05:06:07.000000000 +0000 1772600767 "
        f"{_MTIME_SHOWN} {_MTIME_EPOCH}"
    )


async def _default(fs: FileStat) -> list[str]:
    out, io = await stat(
        [PathSpec.from_str_path("/data/f.txt")],
        stat_fn=partial(_const_stat, fs),
    )
    assert io.exit_code == 0
    return (await materialize(out)).decode().splitlines()


@pytest.mark.asyncio
async def test_default_times_are_the_directives_times_in_gnu_layout():
    # The Access line is %x, which falls back to the mtime; a naive stamp
    # is UTC and an offset one is moved to UTC; the fraction is the digits
    # the stamp carries, so both hosts print the same line.
    lines = await _default(
        _fs(
            modified="2026-03-04T05:06:07.123456789",
            ctime="2026-03-04T07:06:07.5+02:00",
            birthtime="2026-03-04T05:06:07Z",
        )
    )
    assert lines[4:] == [
        "Access: 2026-03-04 05:06:07.123456789 +0000",
        "Modify: 2026-03-04 05:06:07.123456789 +0000",
        "Change: 2026-03-04 05:06:07.500000000 +0000",
        " Birth: 2026-03-04 05:06:07.000000000 +0000",
    ]
    assert (await _default(_fs(modified="not a time")))[5] == "Modify: -"


@pytest.mark.asyncio
async def test_default_layout_names_a_device_type():
    lines = await _default(
        _fs(
            type=FileType.CHAR_DEVICE,
            size=None,
            extra={DEVICE_NUMBERS_KEY: [1, 3]},
        )
    )
    assert lines[1].endswith("character special file")
    assert lines[2] == (
        "Device: ?\tInode: ?           Links: ?     Device type: 1,3"
    )
