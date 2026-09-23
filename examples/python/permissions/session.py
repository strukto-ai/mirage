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
import errno

from mirage import MountMode, Workspace
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Session

# One agent, one session. `ws.session(id, profile=...)` creates a session
# under a role and hands back its two doors bound together: `shell`
# runs a shell line as the session and `vfs` is the op facade run as it.
# Whichever door an agent's tools use, the same profile answers.
#
# Two roles read one world and see two filesystems. The reviewer's
# profile hides /repo/secrets and its session caps /repo at read, so the
# directory does not exist for it on either door and a write is a
# read-only file system on either door. The editor may write, and a
# deny rule keeps it out of the secrets by name, so the same file is
# "does not exist" for one role and "permission denied" for the other,
# through the shell and through vfs.read alike. The workspace names no
# default profile, so its own doors (`ws.vfs`, bare `ws.shell`) are
# the host's view. A second `ws.session(id)` adopts the session as is;
# naming a profile for a session that already exists is refused.

PROFILES = {
    "reviewer": {
        "paths": {
            "hide": ["/repo/secrets"]
        }
    },
    "editor": {
        "commands": {
            "deny": [{
                "reason": "keys are never read by hand",
                "paths": ["/repo/secrets/*"],
            }]
        }
    },
}

SEED = [
    "mkdir -p /repo/secrets",
    "echo 'hello repo' > /repo/README.md",
    "echo 'PRIVATE' > /repo/secrets/key.pem",
]


def shell(out: bytes, err: bytes, code: int) -> str:
    """Render one shell line's answer.

    Args:
        out (bytes): the line's stdout.
        err (bytes): the line's stderr.
        code (int): the line's exit code.
    """
    if err:
        return f"[{code}] {err.decode().splitlines()[0]}"
    return f"[{code}] {' '.join(out.decode().split())}".rstrip()


def show(role: str, door: str, call: str, answer: str, note: str) -> None:
    """Print one probe as the truth file records it.

    Args:
        role (str): whose session answered.
        door (str): which of its doors.
        call (str): what was asked.
        answer (str): what came back.
        note (str): why it matters.
    """
    print(f"{role:9} {door:9} {call:34} {answer}")
    print(f"{'':9} {'':9} {'':34} {note}")


async def line(role: str, handle: Session | Workspace, cmd: str,
               note: str) -> None:
    """Run one shell line through a session's shell door and print it.

    Args:
        role (str): whose session.
        handle (Session | Workspace): the doors; the workspace's
            own are the host's.
        cmd (str): the shell line.
        note (str): why it matters.
    """
    res = await handle.shell(cmd)
    show(role, "shell", cmd,
         shell(res.stdout or b"", res.stderr or b"", res.exit_code), note)


async def read(role: str,
               handle: Session | Workspace,
               path: str,
               note: str,
               session_id: str | None = None) -> None:
    """Read one path through a session's op door and print the answer.

    Args:
        role (str): whose session.
        handle (Session | Workspace): the doors.
        path (str): the virtual path.
        note (str): why it matters.
        session_id (str | None): name one session for this call alone,
            the way ``shell`` takes one; None reads as the door's own.
    """
    call = path if session_id is None else f"{path} as {session_id}"
    try:
        data = await handle.vfs.read(path, session_id=session_id)
    except OSError as exc:
        show(role, "vfs.read", call, errno.errorcode[exc.errno], note)
    else:
        show(role, "vfs.read", call, data.decode().strip(), note)


async def write(role: str, handle: Session | Workspace, path: str,
                note: str) -> None:
    """Write one path through a session's op door and print the answer.

    Args:
        role (str): whose session.
        handle (Session | Workspace): the doors.
        path (str): the virtual path.
        note (str): why it matters.
    """
    try:
        await handle.vfs.write(path, f"{role} wrote\n".encode())
    except OSError as exc:
        show(role, "vfs.write", path, errno.errorcode[exc.errno], note)
    else:
        show(role, "vfs.write", path, "ok", note)


async def main() -> None:
    ws = Workspace({"/repo/": RAMVFS()},
                   mode=MountMode.WRITE,
                   profiles=PROFILES)
    for seed in SEED:
        await ws.shell(seed)

    reviewer = await ws.session("reviewer",
                                profile="reviewer",
                                mounts={"/repo": "read"})
    editor = await ws.session("editor", profile="editor")

    await line("reviewer", reviewer, "cat /repo/README.md",
               "the shell door, as the reviewer")
    await line("reviewer", reviewer, "cat /repo/secrets/key.pem",
               "the reviewer's profile hides the directory")
    await line("editor", editor, "cat /repo/secrets/key.pem",
               "the editor's rule denies the file by name")
    await read("reviewer", reviewer, "/repo/secrets/key.pem",
               "the op door, the same hide, the same answer")
    await read("editor", editor, "/repo/secrets/key.pem",
               "the op door, the same rule, the same answer")
    await read("host", ws, "/repo/secrets/key.pem",
               "no default profile: the workspace's own door sees it")
    await read("host",
               ws,
               "/repo/secrets/key.pem",
               "the same door, named per call: the reviewer's hide",
               session_id="reviewer")
    await read("host",
               ws,
               "/repo/secrets/key.pem",
               "and the editor's own rule, from the same call site",
               session_id="editor")

    await write("reviewer", reviewer, "/repo/new.txt",
                "the reviewer's handle caps /repo at read")
    await write("editor", editor, "/repo/new.txt", "the editor may write")
    await read("reviewer", reviewer, "/repo/new.txt",
               "one world: the reviewer reads what the editor wrote")
    await line("reviewer", reviewer, "echo x > /repo/new.txt",
               "the shell door reads the same cap")
    await line("editor", editor, "echo x > /repo/new.txt",
               "and the same grant")

    again = await ws.session("reviewer")
    show("reviewer", "session", "ws.session('reviewer')", again.session_id,
         "an existing session is adopted as is")
    try:
        await ws.session("reviewer", profile="editor")
    except ValueError as exc:
        show("reviewer", "session", "ws.session('reviewer', profile=...)",
             f"refused: {exc}", "a profile is set once, at creation")


if __name__ == "__main__":
    asyncio.run(main())
