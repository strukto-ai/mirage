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

from mirage import Deny, MountMode, Policy, SessionContext, Workspace
from mirage.resource.ram import RAMResource
from mirage.runtime.types import ScriptSource

# A release workspace under two policies, one through each door code
# has, and the point of the example is what each door is for:
#
#   a coded Policy     a class passed as ``policies=[...]``. It runs in
#                      this process, needs no engine, may define any of
#                      the five hooks, and speaks for every session:
#                      the operator's own rule.
#   a profile policy   a program passed as a profile's ``policy`` block,
#                      source plus the engine that runs it. It runs
#                      sandboxed on that engine, defines any of the
#                      three admission hooks, and speaks only for the
#                      sessions under that profile.
#
# The same block spelled as a document is policy_yaml.py, beside this
# file.


class OperatorOwnsCredentials(Policy):
    """Refuse an env write that would set a credential, for everyone."""

    async def pre_session(self, ctx: SessionContext) -> Deny | None:
        if ctx.key.startswith("AWS_"):
            return Deny("credentials are set by the operator")
        return None


# The reviewer's program: python source, run on monty. It defines the
# two hooks it has an opinion at and stays silent at the third. A hook
# answers with return: None for no opinion, {"deny": reason} to refuse.
# ``open()`` reads through the workspace, so the command gate can judge
# what a file holds, not only what it is called.
REVIEWER = ScriptSource("""
def pre_command(ctx):
    for path in ctx["command"]["paths"]:
        if "marker" in contents(path):
            return {"deny": "marked files are not read by " + ctx["profile"]}
    return None

def pre_ops(ctx):
    op = ctx["op"]
    if op["write"] and op["path"].startswith("/scratch/cold/"):
        return {"deny": "the cold store is frozen"}
    return None

def contents(path):
    try:
        return open(path).read()
    except OSError:
        return ""
""")

SEED = [
    "mkdir -p /scratch/cold && echo keep > /scratch/cold/k",
    "echo marker > /repo/flagged.txt",
    "echo hello > /repo/notes.txt",
]

# "host" runs the line with no session, which is the workspace's own
# unrestricted view: no profile, so no program, but every coded policy.
LINES = [
    ("reviewer", "cat /repo/notes.txt",
     "pre_command read the file and found no marker"),
    ("reviewer", "cat /repo/flagged.txt",
     "and refuses one that holds it; the reason is for the operator"),
    ("reviewer", "cat /scratch/cold/k", "pre_ops lets a read through"),
    ("reviewer", "echo x > /scratch/cold/f",
     "and refuses a write at the op door"),
    ("reviewer", "rm /scratch/cold/k", "whichever command asked for it"),
    ("reviewer", "export AWS_SECRET=x",
     "the coded policy, at the session door"),
    ("reviewer", "export SAFE=1 && echo $SAFE",
     "silence where no hook objects"),
    ("host", "cat /repo/flagged.txt", "no profile, so no program"),
    ("host", "export AWS_SECRET=x",
     "the coded policy speaks for every session"),
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
            "/repo/": RAMResource(),
            "/scratch/": RAMResource(),
        },
        mode=MountMode.WRITE,
        policies=[OperatorOwnsCredentials()],
        profiles={
            "reviewer": {
                "policy": {
                    "script": REVIEWER,
                    "runtime": "monty",
                },
            },
        },
    )
    try:
        for line in SEED:
            await ws.execute(line)
        ws.create_session("reviewer", profile="reviewer")

        for who, line, note in LINES:
            res = await ws.execute(line,
                                   session_id=None if who == "host" else who)
            outcome = answer(res.stdout or b"", res.stderr or b"",
                             res.exit_code)
            print(f"{who:9} {line:30} {outcome}")
            print(f"{'':9} {'':30} {note}")
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
