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

from mirage import MountMode, Outcome, Scope, Workspace
from mirage.resource.ram import RAMResource

# Two rules that ask: one about a path, one about a whole command.
ROLE = {
    "commands": {
        "allow": ["ls", "cat", "rm"],
        "ask": [{
            "reason": "secrets are reviewed",
            "commands": {
                "cat": ["/data/secret.txt"]
            }
        }, {
            "reason": "deletes are reviewed",
            "commands": ["rm"]
        }],
    },
}


async def run(ws: Workspace, line: str) -> None:
    await ws.fs.write("/data/a.txt", b"a\n")
    await ws.fs.write("/data/secret.txt", b"s\n")
    res = await ws.execute(line, session_id="agent")
    how = "ran" if res.refusal is None else f"refused ({res.refusal.kind})"
    print(f"{line}: {how}, exit {res.exit_code}")


async def main() -> None:
    # No `on_ask`: nobody answers inline, so an asked line is refused for
    # now and its question waits in the ledger under an id the agent is
    # told to quote.
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles={"agent": ROLE})
    ws.create_session("agent", profile="agent")
    try:
        await run(ws, "cat /data/secret.txt")
        await run(ws, "rm /data/a.txt")
        # The host reads the queue, one record per question and oldest
        # first, and answers each by id. ONCE passes one retry of that
        # line; SESSION passes every line the rule covers from now on.
        for waiting in ws.decisions.pending("agent"):
            scope = Scope.ONCE if waiting.command == "cat" else Scope.SESSION
            words = " ".join(waiting.argv)
            print(f"host: {waiting.id} asks {waiting.command} {words}"
                  f" ({waiting.reason}): allow {scope.value}")
            await ws.decisions.answer(waiting.id, Outcome.ALLOW, scope)
        # Each retry consumes its answer.
        await run(ws, "cat /data/secret.txt")
        await run(ws, "rm /data/a.txt")
        # The once grant is spent; the session grant still covers rm.
        await run(ws, "cat /data/secret.txt")
        await run(ws, "rm /data/a.txt")
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
