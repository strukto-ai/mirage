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

from mirage.resource.ram import RAMResource
from mirage.types import CommandSafeguard, MountMode, OnExceed
from mirage.workspace import Workspace


def _build_ws(n_lines: int) -> Workspace:
    r = RAMResource()
    r._store.dirs.add("/")
    body = b"".join(f"line{i}\n".encode() for i in range(n_lines))
    r._store.files["/big.txt"] = body
    return Workspace({"/": (r, MountMode.WRITE)})


def _override(ws: Workspace, name: str, safeguard: CommandSafeguard) -> None:
    mounts = list(ws._registry._mounts)
    if ws._registry.root_mount is not None:
        mounts.append(ws._registry.root_mount)
    for m in mounts:
        m.command_safeguards[name] = safeguard


async def _run(ws: Workspace, cmd: str):
    try:
        io = await ws.execute(cmd)
        stdout = await io.stdout_str()
        stderr = await io.stderr_str()
        return io.exit_code, stdout, stderr
    finally:
        await ws.close()


def test_cat_truncates_at_default_2000():
    ws = _build_ws(2500)
    code, out, err = asyncio.run(_run(ws, "cat /big.txt"))
    assert code == 0
    assert out.count("\n") == 2000
    assert out.startswith("line0\n")
    assert "line1999\n" in out
    assert "line2000" not in out
    assert "truncated" in err


def test_pipe_intermediate_not_capped():
    ws = _build_ws(2500)
    code, out, _ = asyncio.run(_run(ws, "cat /big.txt | wc -l"))
    assert code == 0
    assert out.strip() == "2500"


def test_pipe_terminal_under_limit_no_notice():
    ws = _build_ws(2500)
    code, out, err = asyncio.run(_run(ws, "cat /big.txt | tail -n 3"))
    assert code == 0
    assert out == "line2497\nline2498\nline2499\n"
    assert "truncated" not in err


def test_mount_override_caps_small():
    ws = _build_ws(5)
    _override(ws, "cat", CommandSafeguard(max_lines=3))
    code, out, err = asyncio.run(_run(ws, "cat /big.txt"))
    assert code == 0
    assert out == "line0\nline1\nline2\n"
    assert "truncated" in err


def test_on_exceed_error_mode():
    ws = _build_ws(5)
    _override(ws, "cat", CommandSafeguard(max_lines=3,
                                          on_exceed=OnExceed.ERROR))
    code, out, err = asyncio.run(_run(ws, "cat /big.txt"))
    assert code == 1
    assert out == ""
    assert "truncated" in err


def test_below_limit_untouched():
    ws = _build_ws(5)
    code, out, err = asyncio.run(_run(ws, "cat /big.txt"))
    assert code == 0
    assert out == "line0\nline1\nline2\nline3\nline4\n"
    assert "truncated" not in err
