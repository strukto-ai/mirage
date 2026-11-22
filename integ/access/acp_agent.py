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
"""An ACP agent for ``mirage acp``'s access check.

It answers ``initialize`` and ``session/new`` with what it was offered,
and on ``session/prompt`` writes a file in the session's folder through
the client and reads it back, answering with both replies.
"""

import json
import sys

FOLDER = "/home/integ/proj"


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def receive() -> dict | None:
    line = sys.stdin.readline()
    return json.loads(line) if line else None


def answer(message: dict) -> dict | None:
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        offered = params.get("clientCapabilities", {}).get("fs")
        return {"protocolVersion": 1, "_meta": {"fs": offered}}
    if method == "session/new":
        names = [server["name"] for server in params.get("mcpServers", [])]
        return {"sessionId": "s1", "_meta": {"mcp": names}}
    if method != "session/prompt":
        return None
    asks = [
        ("fs/write_text_file", {"content": "acp\n"}),
        ("fs/read_text_file", {}),
    ]
    answers = []
    for n, (ask, extra) in enumerate(asks):
        path = f"{FOLDER}/acp.txt"
        request = {"sessionId": "s1", "path": path, **extra}
        send(
            {"jsonrpc": "2.0", "id": 100 + n, "method": ask, "params": request}
        )
        answers.append(receive())
    return {"stopReason": "end_turn", "_meta": {"answers": answers}}


while (message := receive()) is not None:
    result = answer(message)
    if result is not None:
        send({"jsonrpc": "2.0", "id": message["id"], "result": result})
