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

from mirage import CommandExplanation, MountMode, Workspace
from mirage.runtime.types import ScriptSource
from mirage.vfs.ram import RAMVFS

# A release workspace under a profile policy: programs passed as a
# profile's ``policy`` block, a list per pre_ method, each with the
# runtime that runs it. They run sandboxed on that runtime, read the same
# ctx a coded policy reads, as JSON, print their answer, and speak only
# for the sessions under that profile.
#
# The same block spelled as a document is policy_yaml.py, beside this
# file.


# The reviewer's programs: python source, run on monty, one for each
# method it has an opinion at. Each defines a function named for that
# method, which takes the same fields a coded policy reads and returns
# its answer: None for no opinion, {"kind": "deny", "reason": ...} to
# refuse. ``open()`` reads
# through the workspace as the session, so the command program can judge
# what a file holds, not only what it is called.
MARKED = ScriptSource("""
def contents(path):
    try:
        return open(path).read()
    except OSError:
        return ""

def pre_command(ctx):
    if any("marker" in contents(path) for path in ctx["paths"]):
        reason = "marked files are not read by " + ctx["profile"]
        return {"kind": "deny", "reason": reason}
""")

COLD = ScriptSource("""
def pre_vfs(ctx):
    if ctx["write"] and ctx["path"].startswith("/scratch/cold/"):
        return {"kind": "deny", "reason": "the cold store is frozen"}
""")

SEED = [
    "mkdir -p /scratch/cold && echo keep > /scratch/cold/k",
    "echo marker > /repo/flagged.txt",
    "echo hello > /repo/notes.txt",
]

# "host" runs the line with no session, which is the workspace's own
# unrestricted view: no profile, so no program.
LINES = [
    (
        "reviewer",
        "cat /repo/notes.txt",
        "pre_command read the file and found no marker",
    ),
    (
        "reviewer",
        "cat /repo/flagged.txt",
        "and refuses one that holds it; the reason is for the operator",
    ),
    (
        "reviewer",
        "export SAFE=1 && echo $SAFE",
        "silence where no method objects",
    ),
    ("host", "cat /repo/flagged.txt", "no profile, so no program"),
]


def answer(out: bytes, err: bytes, code: int) -> str:
    """One line's outcome: what came back, or why nothing did.

    Args:
        out (bytes): the line's stdout.
        err (bytes): the line's stderr.
        code (int): the line's exit code.
    """
    if err:
        return f"[{code}] {err.decode().splitlines()[0]}"
    return f"[{code}] {' '.join(out.decode().split())}".rstrip()


async def main() -> None:
    ws = Workspace(
        {
            "/repo/": RAMVFS(),
            "/scratch/": RAMVFS(),
        },
        mode=MountMode.WRITE,
        profiles={
            "reviewer": {
                "policy": {
                    "pre_command": [{"script": MARKED, "runtime": "monty"}],
                    "pre_vfs": [{"script": COLD, "runtime": "monty"}],
                },
            },
        },
    )
    try:
        for line in SEED:
            await ws.shell(line)
        ws.create_session("reviewer", profile="reviewer")

        for who, line, note in LINES:
            res = await ws.shell(
                line, session_id=None if who == "host" else who
            )
            outcome = answer(
                res.stdout or b"", res.stderr or b"", res.exit_code
            )
            print(f"{who:9} {line:30} {outcome}")
            print(f"{'':9} {'':30} {note}")

        # A dry run names who would speak, through the session's own
        # entry points: a line, as the tree of its commands, and one VFS call
        # of an entry point that sees no command (a file tool, FUSE).
        explain = (await ws.session("reviewer")).explain
        shell_res = await explain.shell("cat /repo/flagged.txt")
        for cmd in shell_res.node.children:
            if not isinstance(cmd, CommandExplanation):
                continue
            for a in cmd.answers:
                print(
                    f"{'explain':9} {'cat /repo/flagged.txt':30} {a.policy}: {a.reason}"
                )
        vfs_res = await explain.vfs.write("/scratch/cold/f", b"draft")
        for a in vfs_res.answers:
            print(
                f"{'explain':9} {'write /scratch/cold/f':30} {a.policy}: {a.reason}"
            )
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
