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
from typing import Any

DAY = 86_400
START = 1762128000
CHANNELS = [
    {"id": "C1", "name": "general", "created": START},
    {"id": "C2", "name": "random", "created": START},
]
DMS = [{"id": "D1", "user": "U1", "created": START}]
PROFILE = {"real_name": "Ana Lima", "display_name": "ana"}
USERS = [
    {"id": "U1", "name": "ana", "real_name": "Ana Lima", "profile": PROFILE}
]
PLAN = {
    "id": "F1",
    "name": "plan.txt",
    "title": "Launch plan",
    "mimetype": "text/plain",
    "filetype": "text",
    "size": 5,
    "timestamp": START + 2 * DAY + 60,
    "url_private_download": "https://files.slack.com/files-pri/T1-F1/download/plan.txt",
    "permalink": "https://acme.slack.com/files/U1/F1/plan.txt",
}


def _message(at: int, text: str, **extra: Any) -> dict[str, Any]:
    return {
        "type": "message",
        "user": "U1",
        "text": text,
        "ts": f"{at}.000001",
    } | extra


MESSAGES = {
    "C1": [
        _message(START + 60, "the deploy is done at acme"),
        _message(
            START + DAY + 60,
            "lunch at noon",
            reactions=[{"name": "rocket", "users": ["U1"], "count": 1}],
        ),
        _message(START + 2 * DAY + 60, "", files=[PLAN]),
        _message(START + 3 * DAY + 60, "deploy again", user_profile=PROFILE),
    ],
    "C2": [
        _message(START + DAY + 60, "a random deploy in Lima"),
        _message(START + 4 * DAY + 60, "", files=[PLAN]),
    ],
    "D1": [_message(START + 60, "deploy in a dm")],
}


class FakeSlack:
    """The Slack Web API the sim's workspace answers in memory: channel
    and DM listings, users, the workspace URL, each channel's history and
    the one file's bytes.

    The sim runs on a loop that refuses real I/O, so it cannot reach the
    integ Slack fake the unit tests use. Each call yields to the loop
    once, as a request does.
    """

    async def get(self, accessor, method, params=None):
        await asyncio.sleep(0)
        params = params or {}
        if method == "conversations.list":
            types = params["types"].split(",")
            channels = [
                *(CHANNELS if "public_channel" in types else []),
                *(DMS if "im" in types else []),
            ]
            return {"ok": True, "channels": channels}
        if method == "users.list":
            return {"ok": True, "members": USERS}
        if method == "auth.test":
            return {"ok": True, "url": "https://acme.slack.com/"}
        if method == "conversations.history":
            oldest = float(params.get("oldest", 0))
            latest = float(params.get("latest", "inf"))
            found = [
                m
                for m in reversed(MESSAGES[params["channel"]])
                if oldest <= float(m["ts"]) <= latest
            ]
            return {"ok": True, "messages": found[: int(params["limit"])]}
        raise AssertionError(f"the sim's Slack does not answer {method}")

    async def download(self, accessor, url, offset=0, size=None):
        return b"plan\n"

    async def download_stream(self, accessor, url):
        yield b"plan\n"
