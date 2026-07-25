from functools import partial

import pytest

from mirage.commands.builtin.generic.stat import stat
from mirage.io.types import materialize
from mirage.resource.ram import RAMResource
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.workspace import Workspace

_MTIME = "2026-01-02T15:30:45Z"
_MTIME_EPOCH = "1767367845"


class _OverlayRAMResource(RAMResource):
    """RAM resource with native setattr stripped, standing in for an API
    backend whose chmod/chown/touch live only in the namespace overlay."""

    def __init__(self) -> None:
        super().__init__()
        self._ops_list = [ro for ro in self._ops_list if ro.name != "setattr"]


def _fs(**kw: object) -> FileStat:
    base: dict[str, object] = dict(name="f.txt",
                                   size=6,
                                   modified=_MTIME,
                                   type=FileType.TEXT)
    base.update(kw)
    return FileStat(**base)


async def _const_stat(fs: FileStat, _p: PathSpec) -> FileStat:
    return fs


async def _render(fmt: str, fs: FileStat) -> str:
    out, io = await stat([PathSpec.from_str_path("/data/f.txt")],
                         stat_fn=partial(_const_stat, fs),
                         c=fmt)
    assert io.exit_code == 0
    return (await materialize(out)).decode().rstrip("\n")


async def _run(ws: Workspace, cmd: str) -> tuple[int, str, str]:
    r = await ws.execute(cmd)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


@pytest.mark.asyncio
async def test_name_quoted_size_type():
    assert await _render("%n", _fs()) == "/data/f.txt"
    assert await _render("%N", _fs()) == "'/data/f.txt'"
    assert await _render("%s", _fs(size=42)) == "42"
    assert await _render("%s", _fs(size=None)) == "0"
    assert await _render("%F", _fs()) == "regular file"
    assert await _render("%F", _fs(type=FileType.DIRECTORY)) == "directory"


@pytest.mark.asyncio
async def test_mode_directives_default_and_explicit():
    # No mode -> GNU-style 0644 file default (matches ls -l fallback).
    assert await _render("%a", _fs(mode=None)) == "644"
    assert await _render("%A", _fs(mode=None)) == "-rw-r--r--"
    assert await _render("%f", _fs(mode=None)) == "81a4"
    # Explicit mode.
    assert await _render("%a", _fs(mode=0o640)) == "640"
    assert await _render("%A", _fs(mode=0o640)) == "-rw-r-----"
    assert await _render("%f", _fs(mode=0o640)) == "81a0"
    # Setuid keeps the high octal digit; %f carries the regular-file bits.
    assert await _render("%a", _fs(mode=0o4755)) == "4755"
    assert await _render("%f", _fs(mode=0o4755)) == "89ed"


@pytest.mark.asyncio
async def test_mode_directives_directory_default():
    d = _fs(type=FileType.DIRECTORY, size=None, mode=None)
    assert await _render("%a", d) == "755"
    assert await _render("%A", d) == "drwxr-xr-x"
    assert await _render("%f", d) == "41ed"
    assert await _render("%s", d) == "0"


@pytest.mark.asyncio
async def test_special_permission_bits_in_A():
    # setuid/setgid/sticky render as s/S/t/T, matching %a's high octal digit.
    assert await _render("%A", _fs(mode=0o4755)) == "-rwsr-xr-x"
    assert await _render("%A", _fs(mode=0o4644)) == "-rwSr--r--"
    assert await _render("%A", _fs(mode=0o2755)) == "-rwxr-sr-x"
    assert await _render("%A", _fs(mode=0o1755)) == "-rwxr-xr-t"
    assert await _render("%A", _fs(mode=0o1644)) == "-rw-r--r-T"


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


@pytest.mark.asyncio
async def test_quoted_name_is_shell_safe():
    assert await _render("%N", _fs()) == "'/data/f.txt'"
    # An apostrophe in the path switches to double quotes.
    ap, _io = await stat([PathSpec.from_str_path("/data/a'b.txt")],
                         stat_fn=partial(_const_stat, _fs()),
                         c="%N")
    assert (await materialize(ap)).decode() == "\"/data/a'b.txt\"\n"
    # Both quote kinds -> single-quote with escaped apostrophes.
    both, _io2 = await stat([PathSpec.from_str_path("/data/a'b\"c")],
                            stat_fn=partial(_const_stat, _fs()),
                            c="%N")
    assert (await materialize(both)).decode() == "'/data/a'\\''b\"c'\n"


@pytest.mark.asyncio
async def test_owner_directives():
    owned = _fs(uid=1000, gid="dev")
    assert await _render("%u", owned) == "1000"
    assert await _render("%U", owned) == "1000"
    assert await _render("%g", owned) == "dev"
    assert await _render("%G", owned) == "dev"
    # No owner -> neutral "user" placeholder (matches ls -l).
    bare = _fs(uid=None, gid=None)
    assert await _render("%u %U %g %G", bare) == "user user user user"


@pytest.mark.asyncio
async def test_time_directives():
    fs = _fs(modified=_MTIME, atime="2026-03-04T05:06:07Z")
    assert await _render("%y", fs) == _MTIME
    assert await _render("%Y", fs) == _MTIME_EPOCH
    # ctime is approximated by mtime (mirage tracks no separate ctime).
    assert await _render("%z", fs) == _MTIME
    assert await _render("%Z", fs) == _MTIME_EPOCH
    assert await _render("%x", fs) == "2026-03-04T05:06:07Z"
    assert await _render("%X", fs) == "1772600767"


@pytest.mark.asyncio
async def test_atime_falls_back_to_mtime():
    fs = _fs(modified=_MTIME, atime=None)
    assert await _render("%x", fs) == _MTIME
    assert await _render("%X", fs) == _MTIME_EPOCH


@pytest.mark.asyncio
async def test_birth_and_epoch_of_unknown_time():
    # GNU's own unknown sentinels: birth is "-" / 0.
    assert await _render("%w", _fs()) == "-"
    assert await _render("%W", _fs()) == "0"
    # Epoch of an absent time is 0.
    assert await _render("%Y", _fs(modified=None)) == "0"


@pytest.mark.asyncio
async def test_structural_constants():
    fs = _fs()
    assert await _render("%B", fs) == "512"
    # No character/block special files exist -> device type is 0, truthfully.
    assert await _render("%r %R %t %T", fs) == "0 0 0 0"


@pytest.mark.asyncio
async def test_unbacked_directives_render_question_mark():
    fs = _fs()
    for spec in ("%i", "%d", "%D", "%h", "%b", "%o", "%m", "%C"):
        assert await _render(spec, fs) == "?", spec


@pytest.mark.asyncio
async def test_literal_percent_and_unknown_and_text():
    assert await _render("100%%", _fs()) == "100%"
    assert await _render("%q", _fs()) == "?"
    assert await _render("size=%s type=%F",
                         _fs(size=6)) == "size=6 type=regular file"


@pytest.mark.asyncio
async def test_missing_operand_raises():
    with pytest.raises(ValueError, match="missing operand"):
        await stat([], stat_fn=partial(_const_stat, _fs()), c="%n")


@pytest.mark.asyncio
async def test_error_operand_continues_and_exits_one():
    ok = PathSpec.from_str_path("/data/ok.txt")
    bad = PathSpec.from_str_path("/data/bad.txt")

    async def _stat_fn(p: PathSpec) -> FileStat:
        if p.virtual == bad.virtual:
            raise FileNotFoundError(p.virtual)
        return _fs(size=3)

    out, io = await stat([bad, ok], stat_fn=_stat_fn, c="%s")
    assert io.exit_code == 1
    assert (await materialize(io.stderr)).decode().count("bad.txt") == 1
    assert (await materialize(out)).decode() == "3\n"


@pytest.mark.asyncio
async def test_f_flag_shares_c_formatter():
    # `stat -f` is not filesystem-mode yet (#609 Tier 3); it reuses -c.
    out, io = await stat([PathSpec.from_str_path("/data/f.txt")],
                         stat_fn=partial(_const_stat, _fs(size=6)),
                         f="%s")
    assert (await materialize(out)).decode() == "6\n"


@pytest.mark.asyncio
async def test_stat_reflects_overlay_chmod_chown():
    resource = _OverlayRAMResource()
    resource._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (resource, MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await _run(ws, "chmod 600 /data/f.txt")
    await _run(ws, "chown 501:staff /data/f.txt")
    code, out, _ = await _run(ws, 'stat -c "%a %u %g" /data/f.txt')
    assert code == 0
    assert out == "600 501 staff\n"


@pytest.mark.asyncio
async def test_owner_defaults_to_workspace_agent():
    resource = RAMResource()
    resource._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (resource, MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   agent_id="agent7")
    code, out, _ = await _run(ws, 'stat -c "%U:%G" /data/f.txt')
    assert code == 0
    assert out == "agent7:agent7\n"


@pytest.mark.asyncio
async def test_owner_falls_back_to_user_when_unclaimed():
    resource = RAMResource()
    resource._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (resource, MountMode.WRITE)},
                   mode=MountMode.WRITE)
    code, out, _ = await _run(ws, 'stat -c "%U:%G" /data/f.txt')
    assert code == 0
    assert out == "user:user\n"


@pytest.mark.asyncio
async def test_stat_and_ls_agree_on_owner():
    resource = RAMResource()
    resource._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (resource, MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   agent_id="agent7")
    _, stat_owner, _ = await _run(ws, 'stat -c "%U %G" /data/f.txt')
    _, ls_long, _ = await _run(ws, "ls -l /data/f.txt")
    assert stat_owner.strip() == "agent7 agent7"
    assert "agent7 agent7" in ls_long
