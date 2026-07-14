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
from mirage.resource.ram import RAMResource

# (name, session, command, show) where show selects what the truth file
# records: "out" prints stdout, "err" prints stderr (byte-identical in
# both languages), "exit" prints only whether the command failed (for
# messages that legitimately differ between implementations).
CASES: list[tuple[str, str, str, str]] = [
    ("seed_data", "default", "echo hello > /data/a.txt", "exit"),
    ("seed_side", "default", "echo aside > /side/s.txt", "exit"),
    # ----- read mode: reads pass, writes refuse like a READ mount -----
    ("reader_cat", "reader", "cat /data/a.txt", "out"),
    ("reader_rm_denied", "reader", "rm /data/a.txt", "err"),
    ("reader_redirect_denied", "reader", "echo leak > /data/new.txt", "exit"),
    ("reader_no_partial_write", "reader", "ls /data", "out"),
    # ----- unlisted mount: invisible -----
    ("reader_side_denied", "reader", "cat /side/s.txt", "err"),
    # ----- write mode and list-form inherit -----
    ("writer_write", "writer", "echo w > /data/w.txt && cat /data/w.txt", "out"
     ),
    ("lister_inherits_write", "lister",
     "echo l > /data/l.txt && cat /data/l.txt", "out"),
    # ----- a session mode cannot widen a READ mount -----
    ("widen_attempt_denied", "capped", "echo up > /ro/y.txt", "exit"),
    # ----- restricted sessions keep pure text pipelines -----
    ("reader_pathless_wc", "reader", "echo hi | wc -l", "out"),
]

ROOT_CASES: list[tuple[str, str, str, str]] = [
    ("root_seed", "default", "echo top > /root.txt", "exit"),
    ("root_unlisted_denied", "no_root", "cat /root.txt", "err"),
    ("root_read_mode", "root_ro", "cat /root.txt", "out"),
    ("root_write_denied", "root_ro", "echo x > /root.txt", "exit"),
]


async def run(ws: Workspace, label: str, cases: list[tuple[str, str, str,
                                                           str]]) -> None:
    for name, session, cmd, show in cases:
        result = await ws.execute(cmd, session_id=session)
        print(f"=== {label}:{name} ===")
        if show == "out":
            out = await result.stdout_str()
            print(out, end="" if out.endswith("\n") else "\n")
        elif show == "err":
            err = await result.stderr_str()
            print(err, end="" if err.endswith("\n") else "\n")
        print(f"failed={result.exit_code != 0}")


async def main() -> None:
    ws = Workspace(
        {
            "/data": (RAMResource(), MountMode.WRITE),
            "/side": (RAMResource(), MountMode.WRITE),
            "/ro": (RAMResource(), MountMode.READ),
        },
        mode=MountMode.WRITE,
    )
    ws.create_session("reader", mounts={"/data": "read"})
    ws.create_session("writer", mounts={"/data": "write"})
    ws.create_session("lister", mounts=["/data"])
    ws.create_session("capped", mounts={"/ro": "write"})
    await run(ws, "modes", CASES)

    ws_root = Workspace(
        {
            "/": (RAMResource(), MountMode.WRITE),
            "/data": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    ws_root.create_session("no_root", mounts={"/data": "write"})
    ws_root.create_session("root_ro", mounts={"/data": "write", "/": "read"})
    await run(ws_root, "root", ROOT_CASES)


if __name__ == "__main__":
    asyncio.run(main())
