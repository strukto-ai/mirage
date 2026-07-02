# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.metadata import (parse_mode,
                                                         parse_owner,
                                                         parse_touch_stamp)


def test_parse_mode_octal():
    assert parse_mode("644", 0) == 0o644
    assert parse_mode("0", 0o777) == 0
    assert parse_mode("7777", 0) == 0o7777


def test_parse_mode_octal_out_of_range():
    assert parse_mode("77777", 0) is None


def test_parse_mode_symbolic_add():
    assert parse_mode("u+x", 0o644) == 0o744
    assert parse_mode("+x", 0o644) == 0o755


def test_parse_mode_symbolic_remove():
    assert parse_mode("go-r", 0o644) == 0o600


def test_parse_mode_symbolic_assign():
    assert parse_mode("a=r", 0o777) == 0o444
    assert parse_mode("u=rwx,go=", 0o644) == 0o700


def test_parse_mode_symbolic_comma_clauses():
    assert parse_mode("u+x,g-r", 0o644) == 0o704


def test_parse_mode_invalid():
    assert parse_mode("zz", 0o644) is None
    assert parse_mode("u~x", 0o644) is None
    assert parse_mode("u+q", 0o644) is None


def test_parse_owner_forms():
    assert parse_owner("1000:staff") == (1000, "staff")
    assert parse_owner("alice") == ("alice", None)
    assert parse_owner(":dev") == (None, "dev")
    assert parse_owner("500:501") == (500, 501)


def test_parse_touch_stamp_posix():
    assert parse_touch_stamp("202601021530",
                             None) == "2026-01-02T15:30:00+00:00"
    assert parse_touch_stamp("202601021530.45",
                             None) == "2026-01-02T15:30:45+00:00"


def test_parse_touch_stamp_two_digit_year():
    assert parse_touch_stamp("2601021530", None).startswith("2026-")
    assert parse_touch_stamp("9901021530", None).startswith("1999-")


def test_parse_touch_stamp_date_string():
    assert parse_touch_stamp(None, "2026-01-02") == "2026-01-02T00:00:00+00:00"
    assert parse_touch_stamp(None, None) is None


def test_parse_touch_stamp_invalid():
    with pytest.raises(ValueError):
        parse_touch_stamp("13011200", "")
    with pytest.raises(ValueError):
        parse_touch_stamp("2026010215301", None)
    with pytest.raises(ValueError):
        parse_touch_stamp("202601021530.5", None)


class _OverlayRAMResource(RAMResource):
    """RAM resource with the native setattr op stripped, standing in for
    an API backend that has no attribute slot."""

    def __init__(self) -> None:
        super().__init__()
        self._ops_list = [ro for ro in self._ops_list if ro.name != "setattr"]


def _make_ws(mode: MountMode = MountMode.WRITE) -> Workspace:
    resource = RAMResource()
    resource._store.files["/f.txt"] = b"hello"
    return Workspace({"/data/": (resource, mode)}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[int, str, str]:
    r = await ws.execute(cmd)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


@pytest.mark.asyncio
async def test_chmod_renders_in_ls_long():
    ws = _make_ws()
    code, _, _ = await _run(ws, "chmod 601 /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert "-rw------x" in out


@pytest.mark.asyncio
async def test_chmod_symbolic_uses_current_mode():
    ws = _make_ws()
    await _run(ws, "chmod 644 /data/f.txt")
    await _run(ws, "chmod u+x /data/f.txt")
    _, out, _ = await _run(ws, "ls -l /data")
    assert "-rwxr--r--" in out


@pytest.mark.asyncio
async def test_chmod_bad_mode_fails_without_touching_files():
    ws = _make_ws()
    code, _, err = await _run(ws, "chmod zz /data/f.txt")
    assert code == 1
    assert "invalid mode" in err


@pytest.mark.asyncio
async def test_chmod_missing_file_reports_enoent():
    ws = _make_ws()
    code, _, err = await _run(ws, "chmod 644 /data/nope.txt")
    assert code == 1
    assert "nope.txt" in err


@pytest.mark.asyncio
async def test_chown_renders_owner_and_group():
    ws = _make_ws()
    code, _, _ = await _run(ws, "chown 500:dev /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert " 500 dev " in out


@pytest.mark.asyncio
async def test_touch_sets_mtime():
    ws = _make_ws()
    code, _, _ = await _run(ws, "touch -t 202603041200 /data/f.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls -l /data")
    assert "Mar  4 12:00" in out


@pytest.mark.asyncio
async def test_touch_creates_missing_file():
    ws = _make_ws()
    code, _, _ = await _run(ws, "touch /data/new.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls /data")
    assert "new.txt" in out


@pytest.mark.asyncio
async def test_touch_no_create_flag():
    ws = _make_ws()
    code, _, _ = await _run(ws, "touch -c /data/ghost.txt")
    assert code == 0
    _, out, _ = await _run(ws, "ls /data")
    assert "ghost.txt" not in out


@pytest.mark.asyncio
async def test_chmod_follows_symlink():
    ws = _make_ws()
    await _run(ws, "ln -s /data/f.txt /data/link")
    await _run(ws, "chmod 640 /data/link")
    _, out, _ = await _run(ws, "ls -l /data")
    assert "-rw-r----- 1 user user 5" in out


@pytest.mark.asyncio
async def test_metadata_commands_respect_read_only_mount():
    ws = _make_ws(MountMode.READ)
    for cmd in ("chmod 644 /data/f.txt", "chown alice /data/f.txt",
                "touch /data/f.txt"):
        code, _, err = await _run(ws, cmd)
        assert code == 1
        assert "read-only mount" in err


@pytest.mark.asyncio
async def test_overlay_fallback_when_mount_has_no_setattr():
    resource = _OverlayRAMResource()
    resource._store.files["/f.txt"] = b"hello"
    ws = Workspace({"/data/": (resource, MountMode.WRITE)},
                   mode=MountMode.WRITE)
    code, _, _ = await _run(
        ws, "chmod 601 /data/f.txt && chown 500:dev /data/f.txt"
        " && touch -t 202603041200 /data/f.txt")
    assert code == 0
    assert resource._store.attrs == {}
    st, _ = await ws.dispatch("stat", PathSpec.from_str_path("/data/f.txt"))
    assert st.mode == 0o601
    assert st.uid == 500
    assert st.gid == "dev"
    assert st.modified == "2026-03-04T12:00:00Z"
