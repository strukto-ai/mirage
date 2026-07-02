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

from mirage import MountMode, Workspace
from mirage.commands import safeguard as sg
from mirage.commands.builtin.utils.safeguard import SafeguardExceededError
from mirage.resource.ram import RAMResource
from mirage.types import CommandSafeguard, OnExceed, PathSpec

A_LINES = "1\n2\n3\n4\n5\n"
B_LINES = "6\n7\n8\n9\n10\n"
SMALL_LINES = "x\ny\n"
C_BYTES = "abcdefgh"
SUB_MATCHES = "match\nmatch\nmatch\n"

CASES: list[tuple[str, str]] = [
    ("single_cat_truncate", "cat /a/f.txt"),
    ("single_cat_error", "cat /b/f.txt"),
    ("within_limit_no_fire", "cat /a/small.txt"),
    ("max_bytes_truncate", "cat /c/f.txt"),
    ("pipe_rightmost_truncate", "cat /a/f.txt | head"),
    ("pipe_rightmost_error", "cat /a/f.txt | grep ."),
    ("command_limit_under_safeguard", "cat /a/f.txt | head -n 2"),
    ("semicolon_rightmost_truncate", "cat /b/f.txt ; cat /a/f.txt"),
    ("and_rightmost_error", "cat /a/f.txt && cat /b/f.txt"),
    ("or_rightmost_truncate", "false || cat /a/f.txt"),
    ("subshell_rightmost", "( cat /b/f.txt ; cat /a/f.txt )"),
    ("cross_mount_cat_tightest", "cat /a/f.txt /b/f.txt"),
    ("traversal_grep_r_tightest", "grep -r match /a"),
    ("timeout_fires", "sleep 2"),
    ("timeout_in_pipe", "sleep 2 | cat"),
]

VFS_CASES: list[tuple[str, str]] = [
    ("vfs_read_truncate", "/c/f.txt"),
    ("vfs_read_error", "/d/f.txt"),
]


def _build_ws() -> Workspace:
    sg.DEFAULT_COMMAND_SAFEGUARDS["head"] = CommandSafeguard(
        max_lines=3, on_exceed=OnExceed.TRUNCATE)
    sg.DEFAULT_COMMAND_SAFEGUARDS["grep"] = CommandSafeguard(
        max_lines=2, on_exceed=OnExceed.ERROR)
    sg.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
        timeout_seconds=0.1)
    a = RAMResource()
    b = RAMResource()
    c = RAMResource()
    d = RAMResource()
    sub = RAMResource()
    return Workspace(
        {
            "/a/": (a, MountMode.WRITE, {
                "cat":
                CommandSafeguard(max_lines=4, on_exceed=OnExceed.TRUNCATE),
                "grep":
                CommandSafeguard(max_lines=2, on_exceed=OnExceed.ERROR),
            }),
            "/a/sub/": (sub, MountMode.WRITE, {
                "grep":
                CommandSafeguard(max_lines=1, on_exceed=OnExceed.ERROR),
            }),
            "/b/":
            (b, MountMode.WRITE, {
                "cat": CommandSafeguard(max_lines=2, on_exceed=OnExceed.ERROR),
            }),
            "/c/": (c, MountMode.WRITE, {
                "cat":
                CommandSafeguard(max_bytes=5, on_exceed=OnExceed.TRUNCATE),
                "read":
                CommandSafeguard(max_bytes=4, on_exceed=OnExceed.TRUNCATE),
            }),
            "/d/": (d, MountMode.WRITE, {
                "read":
                CommandSafeguard(max_bytes=4, on_exceed=OnExceed.ERROR),
            }),
        },
        mode=MountMode.WRITE)


async def main() -> None:
    ws = _build_ws()
    await ws.execute("mkdir -p /a/sub")
    await ws.execute(f"printf '{A_LINES}' > /a/f.txt")
    await ws.execute(f"printf '{B_LINES}' > /b/f.txt")
    await ws.execute(f"printf '{SMALL_LINES}' > /a/small.txt")
    await ws.execute(f"printf '{C_BYTES}' > /c/f.txt")
    await ws.execute(f"printf '{C_BYTES}' > /d/f.txt")
    await ws.execute(f"printf '{SUB_MATCHES}' > /a/sub/g.txt")

    for name, cmd in CASES:
        result = await ws.execute(cmd)
        out = await result.stdout_str()
        err = await result.stderr_str()
        print(f"=== {name} ===")
        print(f"exit={result.exit_code}")
        if out:
            print(out, end="" if out.endswith("\n") else "\n")
        if "output truncated" in err:
            print("note=truncated")
        if "timed out" in err:
            print("note=timed_out")

    for name, path in VFS_CASES:
        print(f"=== {name} ===")
        try:
            value, _ = await ws.dispatch("read", PathSpec.from_str_path(path))
            print(f"read={value.decode()}")
        except SafeguardExceededError:
            print("read=<raised SafeguardExceededError>")


if __name__ == "__main__":
    asyncio.run(main())
