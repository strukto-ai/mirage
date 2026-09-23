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

import asyncio

import pytest

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.shell.console import Channel
from mirage.shell.job_table import JobStatus
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace.snapshot import apply_state_dict, read_tar
from mirage.workspace.workspace import Workspace


@command("history", vfs="ram", spec=SPECS["history"])
async def fake_history(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    return b"FAKE\n", IOResult()


def _ws() -> Workspace:
    return Workspace({"/data": (RAMVFS(), MountMode.WRITE)})


def _exec(ws: Workspace, cmd: str, **kw) -> IOResult:
    return asyncio.run(ws.shell(cmd, **kw))


def _stdout(io: IOResult) -> str:
    if io.stdout is None:
        return ""
    if isinstance(io.stdout, memoryview):
        return bytes(io.stdout).decode()
    if isinstance(io.stdout, (bytes, bytearray)):
        return bytes(io.stdout).decode()
    return ""


def test_history_command_per_session():
    ws = _ws()
    ws.create_session("s2")
    _exec(ws, "ls /data")
    _exec(ws, "pwd")
    _exec(ws, "ls /", session_id="s2")
    mine = _stdout(_exec(ws, "history"))
    other = _stdout(_exec(ws, "history", session_id="s2"))
    assert "ls /data" in mine
    assert "pwd" in mine
    assert "ls /data" not in other
    assert "ls /" in other


def test_history_builtin_wins_over_mount_command():
    res = RAMVFS()
    res.register(fake_history)
    ws = Workspace({"/data": (res, MountMode.WRITE)})
    _exec(ws, "ls /data")
    out = _stdout(_exec(ws, "history", cwd="/data"))
    assert "FAKE" not in out
    assert "ls /data" in out


def test_cat_bash_history_all_sessions():
    ws = _ws()
    ws.create_session("s2")
    _exec(ws, "ls /data")
    _exec(ws, "pwd", session_id="s2")
    io = _exec(ws, "cat /.bash_history")
    assert io.exit_code == 0
    out = _stdout(io)
    assert "ls /data" in out
    assert "pwd" in out
    assert out.count("#") >= 2


def test_grep_and_tail_bash_history():
    ws = _ws()
    _exec(ws, "ls /data")
    _exec(ws, "pwd")
    grep_io = _exec(ws, "grep pwd /.bash_history")
    assert grep_io.exit_code == 0
    grep_out = _stdout(grep_io)
    assert "pwd" in grep_out
    assert "ls /data" not in grep_out
    tail_io = _exec(ws, "tail -n 2 /.bash_history")
    assert tail_io.exit_code == 0
    assert "pwd" in _stdout(tail_io)


@pytest.mark.asyncio
async def test_a_followed_history_streams_each_new_command():
    # The history registration hands tail_generic a stat, so -f polls
    # the view; without one the follow would print one snapshot and
    # exit.
    ws = _ws()
    try:
        await ws.shell("pwd")
        await ws.shell("tail -f -s 0.05 /.bash_history &")
        await asyncio.sleep(0.15)
        await ws.shell("echo marker")
        await asyncio.sleep(0.25)
        job = ws.job_table.get(1, ws.default_session_id)
        assert job is not None
        assert job.status is JobStatus.RUNNING
        shown = await job.console.snapshot(Channel.STDOUT)
        assert b"pwd" in shown
        assert b"echo marker" in shown
        assert (await ws.shell("kill %1")).exit_code == 0
    finally:
        await ws.close()


def test_ls_root_hides_dotfile_ls_a_shows():
    ws = _ws()
    plain = _stdout(_exec(ws, "ls /"))
    dotted = _stdout(_exec(ws, "ls -a /"))
    assert ".bash_history" not in plain
    assert ".bash_history" in dotted


def test_history_c_clears_only_my_session_file_unchanged():
    ws = _ws()
    ws.create_session("s2")
    _exec(ws, "ls /data")
    _exec(ws, "pwd", session_id="s2")
    clear_io = _exec(ws, "history -c")
    assert clear_io.exit_code == 0
    mine = _stdout(_exec(ws, "history"))
    other = _stdout(_exec(ws, "history", session_id="s2"))
    file_out = _stdout(_exec(ws, "cat /.bash_history"))
    assert "ls /data" not in mine
    assert "pwd" in other
    assert "ls /data" in file_out


def test_append_to_bash_history_rejected():
    ws = _ws()
    io = _exec(ws, "echo hacked >> /.bash_history")
    assert io.exit_code != 0


def test_sessions_path_no_longer_resolves():
    ws = _ws()
    io = _exec(ws, "ls /.sessions")
    assert io.exit_code != 0


def test_unmount_history_view_rejected():
    ws = _ws()
    with pytest.raises(ValueError, match="history view"):
        asyncio.run(ws.unmount("/.bash_history"))


def test_snapshot_roundtrip_preserves_tombstones(tmp_path):
    ws = _ws()
    _exec(ws, "ls /data")
    _exec(ws, "history -c")
    _exec(ws, "pwd")
    snap = tmp_path / "ws.tar"
    asyncio.run(ws.snapshot(snap))
    dst = asyncio.run(Workspace.load(snap))
    mine = _stdout(_exec(dst, "history"))
    file_out = _stdout(_exec(dst, "cat /.bash_history"))
    assert "ls /data" not in mine
    assert "pwd" in mine
    assert "ls /data" in file_out


def test_workspace_history_method():
    ws = _ws()
    _exec(ws, "ls /data")
    _exec(ws, "pwd")
    events = asyncio.run(ws.history())
    assert [e["command"] for e in events] == ["ls /data", "pwd"]
    assert all(e["type"] == "command" for e in events)


def test_history_s_appends_without_executing():
    ws = _ws()
    _exec(ws, "pwd")
    io = _exec(ws, "history -s rm -rf /data")
    assert io.exit_code == 0
    out = _stdout(_exec(ws, "history"))
    assert "rm -rf /data" in out
    assert _exec(ws, "ls /data/x").exit_code != 0


def test_history_d_deletes_and_renumbers():
    ws = _ws()
    _exec(ws, "pwd")
    _exec(ws, "echo keep")
    io = _exec(ws, "history -d 1")
    assert io.exit_code == 0
    out = _stdout(_exec(ws, "history"))
    assert "pwd" not in out.split("history -d 1")[0]
    assert out.startswith("1  echo keep")


def test_history_d_attached_offset_deletes():
    ws = _ws()
    _exec(ws, "pwd")
    _exec(ws, "echo keep")
    io = _exec(ws, "history -d1")
    assert io.exit_code == 0
    out = _stdout(_exec(ws, "history"))
    assert out.startswith("1  echo keep")


def test_history_d_out_of_range():
    ws = _ws()
    _exec(ws, "pwd")
    io = _exec(ws, "history -d 99")
    assert io.exit_code == 1
    assert b"99: history position out of range" in io.stderr


def test_history_d_non_numeric():
    ws = _ws()
    io = _exec(ws, "history -d abc")
    assert io.exit_code == 1
    assert b"abc: history position out of range" in io.stderr


def test_history_d_trailing_garbage_rejected():
    ws = _ws()
    _exec(ws, "pwd")
    io = _exec(ws, "history -d 1abc")
    assert io.exit_code == 1
    assert b"1abc: history position out of range" in io.stderr


def test_history_count_trailing_garbage_rejected():
    ws = _ws()
    _exec(ws, "pwd")
    io = _exec(ws, "history 3abc")
    assert io.exit_code == 1
    assert b"3abc: numeric argument required" in io.stderr


def test_history_d_negative_offset_deletes_last():
    ws = _ws()
    _exec(ws, "echo first")
    _exec(ws, "echo last")
    io = _exec(ws, "history -d -1")
    assert io.exit_code == 0
    out = _stdout(_exec(ws, "history"))
    assert "echo first" in out
    lines = [ln for ln in out.splitlines() if "echo last" in ln]
    assert lines == []


def test_history_d_requires_argument():
    ws = _ws()
    io = _exec(ws, "history -d")
    assert io.exit_code == 2
    assert b"-d: option requires an argument" in io.stderr
    assert b"history: usage:" in io.stderr


def test_history_invalid_option_usage_exit_2():
    ws = _ws()
    io = _exec(ws, "history -z")
    assert io.exit_code == 2
    assert b"-z: invalid option" in io.stderr
    assert b"history: usage:" in io.stderr


def test_history_p_prints_without_storing_args():
    ws = _ws()
    io = _exec(ws, "history -p hello world")
    assert io.exit_code == 0
    assert _stdout(io) == "hello\nworld\n"
    out = _stdout(_exec(ws, "history"))
    assert "1  history -p hello world" in out


def test_history_ps_suppresses_print():
    ws = _ws()
    io = _exec(ws, "history -ps echo hi")
    assert io.exit_code == 0
    assert _stdout(io) == ""
    out = _stdout(_exec(ws, "history"))
    assert "echo hi" in out


def test_history_zero_lists_nothing():
    ws = _ws()
    _exec(ws, "pwd")
    _exec(ws, "echo two")
    io = _exec(ws, "history 0")
    assert io.exit_code == 0
    assert _stdout(io) == ""


def test_history_sync_flags_are_noops():
    ws = _ws()
    _exec(ws, "pwd")
    for flag in ("-a", "-r", "-w", "-n"):
        io = _exec(ws, f"history {flag}")
        assert io.exit_code == 0
        assert _stdout(io) == ""


def test_history_cluster_cw():
    ws = _ws()
    _exec(ws, "pwd")
    io = _exec(ws, "history -cw")
    assert io.exit_code == 0
    out = _stdout(_exec(ws, "history 1"))
    assert "pwd" not in out


def test_find_view_via_generic():
    ws = _ws()
    out = _stdout(_exec(ws, "find /.bash_history"))
    assert out == "/.bash_history\n"
    out = _stdout(_exec(ws, "find /.bash_history -name '*.bash*'"))
    assert out == "/.bash_history\n"
    out = _stdout(_exec(ws, "find /.bash_history -type d"))
    assert out == ""


def test_substitution_records_only_outer_line():
    ws = _ws()
    _exec(ws, "echo hi > /data/f.txt")
    _exec(ws, "wc -l $(find /data -name '*.txt')")
    commands = [e["command"] for e in asyncio.run(ws.history())]
    assert commands == [
        "echo hi > /data/f.txt",
        "wc -l $(find /data -name '*.txt')",
    ]


def test_substitution_keeps_inner_ops_in_audit():
    ws = _ws()
    _exec(ws, "echo hi > /data/f.txt")
    _exec(ws, "echo $(cat /data/f.txt)")
    events = asyncio.run(ws.observer.events())
    reads = [e for e in events if e["type"] == "op" and e["op"] == "read"]
    assert any(e["path"] == "/data/f.txt" for e in reads)


def test_outer_ops_after_substitution_not_lost():
    ws = _ws()
    _exec(ws, "echo hi > /data/f.txt")
    _exec(ws, "wc -l $(find /data -name '*.txt')")
    events = asyncio.run(ws.observer.events())
    reads = [(e["op"], e["path"]) for e in events if e["type"] == "op"]
    assert ("read", "/data/f.txt") in reads


def test_eval_xargs_source_record_single_entry():
    ws = _ws()
    _exec(ws, "echo hi > /data/f.txt")
    _exec(ws, "eval cat /data/f.txt")
    _exec(ws, "echo /data/f.txt | xargs cat")
    _exec(ws, "echo 'cat /data/f.txt' > /data/s.sh")
    _exec(ws, "source /data/s.sh")
    commands = [e["command"] for e in asyncio.run(ws.history())]
    assert commands == [
        "echo hi > /data/f.txt",
        "eval cat /data/f.txt",
        "echo /data/f.txt | xargs cat",
        "echo 'cat /data/f.txt' > /data/s.sh",
        "source /data/s.sh",
    ]


def test_unrecorded_execute_skips_history_keeps_caller_ops():
    ws = _ws()
    _exec(ws, "echo hi > /data/f.txt")
    _exec(ws, "cat /data/f.txt", record=False)
    commands = [e["command"] for e in asyncio.run(ws.history())]
    assert commands == ["echo hi > /data/f.txt"]


async def _raise_induced(io):
    raise RuntimeError("induced")


def test_in_place_restore_rewinds_history(tmp_path):
    src = _ws()
    _exec(src, "echo from-snapshot")
    snap = tmp_path / "s.tar"
    asyncio.run(src.snapshot(snap))
    dst = _ws()
    _exec(dst, "echo pre-restore")
    asyncio.run(apply_state_dict(dst, read_tar(snap)))
    cmds = [e["command"] for e in asyncio.run(dst.history())]
    assert cmds == ["echo from-snapshot"]


def test_failed_line_ops_still_in_audit(monkeypatch):
    ws = _ws()
    _exec(ws, "echo hi > /data/f.txt")
    monkeypatch.setattr(ws, "apply_io", _raise_induced)
    io = _exec(ws, "cat /data/f.txt")
    assert io.exit_code == 1
    events = asyncio.run(ws.observer.events())
    reads = [e for e in events if e["type"] == "op" and e["op"] == "read"]
    assert any(e["path"] == "/data/f.txt" for e in reads)
    last_cmd = [e for e in events if e["type"] == "command"][-1]
    assert last_cmd["command"] == "cat /data/f.txt"
    assert last_cmd["exit_code"] == 1


# bash 5.2 adds a line to history only when it is non-empty
# (`shell_input_line[0]`): a blank line is never recorded, while a
# whitespace-only or comment-only line is. Pinned in debian:stable-slim
# with `printf 'echo one\n\n   \n# comment\n' | bash -i; history -w`.
def test_a_blank_line_is_not_recorded_but_whitespace_and_comments_are():
    ws = _ws()
    _exec(ws, "echo one")
    _exec(ws, "")
    _exec(ws, "\n")
    _exec(ws, "   ")
    _exec(ws, "# comment")
    events = asyncio.run(ws.history())
    assert [e["command"] for e in events] == ["echo one", "   ", "# comment"]
    file_out = _stdout(_exec(ws, "cat /.bash_history"))
    assert "\n\n" not in file_out
    assert "\n   \n" in file_out
    assert "\n# comment\n" in file_out
