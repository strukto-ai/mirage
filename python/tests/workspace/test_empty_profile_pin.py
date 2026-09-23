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

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

# The lines cover every surface the path axis gates: enumeration (ls,
# globs, find), the native fast paths (du -s, find on a backend with a
# find op), the walk (grep -r, du -a), stat and read. The pin is
# "no hide -> identical results": an active-gate that misfires on an
# empty document changes one side and this battery goes red.
BATTERY = (
    "ls /a",
    "ls -la /a && ls /b",
    "echo /a/* /b/*",
    "find /a",
    "find /b -type f",
    "du -s /a",
    "du -a /b",
    "grep -rl needle /a /b",
    "cat /a/x.txt /b/deep/y.txt",
    "stat -c '%n %s' /a/x.txt",
    "test -d /a/sub && echo yes",
)


def _seeded() -> Workspace:
    ws = Workspace(
        {
            "/a": (RAMVFS(), MountMode.WRITE),
            "/b": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE)

    async def seed():
        io = await ws.shell("mkdir -p /a/sub /b/deep && "
                            "printf 'needle a\\n' > /a/x.txt && "
                            "printf 'plain\\n' > /a/sub/inner.txt && "
                            "printf 'needle b\\n' > /b/deep/y.txt")
        assert io.exit_code == 0, io.stderr

    asyncio.run(seed())
    return ws


def _outputs(ws: Workspace,
             session_id: str) -> list[tuple[str, int, bytes, bytes]]:

    async def go():
        out = []
        for line in BATTERY:
            io = await ws.shell(line, session_id=session_id)
            out.append((line, io.exit_code, io.stdout or b"", io.stderr
                        or b""))
        return out

    return asyncio.run(go())


def test_an_empty_profile_changes_nothing():
    # profile {} compiles to all-None narrowing, so every gate must
    # stay inert: the battery is byte-identical to a session with no
    # profile at all.
    #
    # Both sessions read ONE workspace, because the claim is about the
    # profile and nothing else. Two separately seeded worlds differ in a
    # way the profile has no part in: `ls -la` renders mtime to the
    # minute, so seeding them either side of a minute boundary made this
    # go red on a slow runner.
    ws = _seeded()
    ws.create_session("bare")
    ws.create_session("profiled", profile={})
    assert _outputs(ws, "bare") == _outputs(ws, "profiled")


def test_a_hide_on_one_mount_leaves_the_other_byte_identical():
    # The per-operand gate: hiding one entry under /a flips /a's walks
    # off their fast paths, and /b must not notice, whichever path its
    # commands take. Byte-identical output is the whole claim, so a
    # native-op/walk divergence on /b surfaces here.
    ws = _seeded()
    ws.create_session("bare")
    ws.create_session("hidden", profile={"paths": {"hide": ["/a/sub"]}})
    b_lines = [entry for entry in BATTERY if "/a" not in entry]
    bare = [r for r in _outputs(ws, "bare") if r[0] in b_lines]
    hidden = [r for r in _outputs(ws, "hidden") if r[0] in b_lines]
    assert bare == hidden
