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
from pathlib import Path

from mirage import Workspace
from mirage.config import load_config

# The reviewer's policy as a document. workspace.yaml names the program
# (guard.py, beside it) and the engine that runs it; load_config reads
# the file, embeds the program's source, and hands back the kwargs
# Workspace takes, which is what ``mirage workspace create`` does behind
# the daemon. A path in the document is relative to the document, never
# to the process. The in-code spelling of the same block is policy.py.

HERE = Path(__file__).resolve().parent

SEED = [
    "mkdir -p /scratch/cold && echo keep > /scratch/cold/k",
    "echo marker > /repo/flagged.txt",
    "echo hello > /repo/notes.txt",
]

# "host" runs the line with no session, which is the workspace's own
# unrestricted view: no profile, so no program.
LINES = [
    ("reviewer", "cat /repo/notes.txt",
     "pre_command read the file and found no marker"),
    ("reviewer", "cat /repo/flagged.txt", "and refuses one that holds it"),
    ("reviewer", "echo x > /scratch/cold/f",
     "pre_ops refuses a write at the op door"),
    ("reviewer", "export AWS_SECRET=x", "pre_session refuses a credential"),
    ("reviewer", "export SAFE=1 && echo $SAFE",
     "silence where no hook objects"),
    ("host", "cat /repo/flagged.txt", "no profile, so no program"),
    ("host", "export AWS_SECRET=x",
     "the program is the profile's, not the workspace's"),
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
    config = load_config(HERE / "workspace.yaml")
    ws = Workspace(**config.to_workspace_kwargs())
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
