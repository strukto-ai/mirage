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
"""umask: the session file-creation mask, pinned against bash 5.2.37.

The mask prints octal by default and symbolically under ``-S``, applies
to files a redirect, ``touch`` or ``mkdir`` create, and is refused for a
bad mode with the mask left unchanged.
"""
import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.umask.umask import (parse_umask,
                                                            symbolic_umask)


def _ws() -> Workspace:
    return Workspace({"data": RAMVFS()}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[str, int]:
    io = await ws.shell(cmd)
    return (await io.stdout_str()), io.exit_code


@pytest.mark.asyncio
async def test_default_mask_prints_octal_and_symbolic():
    ws = _ws()
    assert await _run(ws, "umask") == ("0022\n", 0)
    assert await _run(ws, "umask -S") == ("u=rwx,g=rx,o=rx\n", 0)
    assert await _run(ws, "umask -p") == ("umask 0022\n", 0)
    await ws.close()


@pytest.mark.asyncio
async def test_set_octal_and_symbolic():
    ws = _ws()
    await _run(ws, "umask 077")
    assert await _run(ws, "umask") == ("0077\n", 0)
    assert await _run(ws, "umask -S") == ("u=rwx,g=,o=\n", 0)
    await _run(ws, "umask g+w")
    assert await _run(ws, "umask") == ("0057\n", 0)
    await ws.close()


@pytest.mark.asyncio
async def test_bad_modes_are_refused_and_leave_the_mask():
    ws = _ws()
    out, code = await _run(ws, "umask 999")
    assert code == 1
    assert await _run(ws, "umask") == ("0022\n", 0)
    _, code = await _run(ws, "umask -x")
    assert code == 2
    await ws.close()


@pytest.mark.asyncio
async def test_mask_applies_to_new_entries():
    ws = _ws()
    await _run(ws, "umask 077; touch /data/f; mkdir /data/d; echo x > /data/r")
    out, _ = await _run(ws, "stat -c '%a %n' /data/f /data/d /data/r")
    assert out == "600 /data/f\n700 /data/d\n600 /data/r\n"
    await ws.close()


@pytest.mark.asyncio
async def test_mkdir_m_ignores_the_mask():
    ws = _ws()
    out, _ = await _run(ws,
                        "umask 077; mkdir -m 755 /data/d; stat -c %a /data/d")
    assert out == "755\n"
    await ws.close()


def test_parse_umask_clamps_and_refuses():
    assert parse_umask("077", 0o022) == 0o077
    assert parse_umask("07777", 0o022) == 0o777
    assert parse_umask("999", 0o022).startswith("bash: umask")
    assert parse_umask("u=rwx,g=,o=", 0o022) == 0o077


def test_symbolic_umask_renders_left_on_bits():
    assert symbolic_umask(0o022) == "u=rwx,g=rx,o=rx"
    assert symbolic_umask(0o077) == "u=rwx,g=,o="
