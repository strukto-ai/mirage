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

import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage import Workspace
from mirage.commands.cli.builtin.tvly import TVLY
from mirage.io.types import materialize

EXTRACT = "https://api.tavily.com/extract"


async def run(line: str) -> tuple[int, str, str]:
    """One line through a workspace with a keyed tvly installed."""
    ws = Workspace({})
    ws.register_cli("tvly", TVLY, {"api_key": "tvly-k"})
    io = await ws.shell(line)
    out = (await materialize(io.stdout)).decode()
    err = (await materialize(io.stderr)).decode()
    await ws.close()
    return io.exit_code, out, err


@pytest.mark.asyncio
async def test_each_page_prints_whole_then_each_failure():
    answer = {
        "results": [{"url": "https://a", "raw_content": "A\n\n\n\nbody"}],
        "failed_results": [{"url": "https://b", "error": "timeout"}, {}],
    }
    with aioresponses() as m:
        m.post(EXTRACT, payload=answer)
        code, out, _ = await run("tvly extract https://a https://b")
    assert code == 0
    assert out == (
        "# https://a\n\nA\n\nbody\n\n"
        "Failed: https://b: timeout\n"
        "Failed: undefined: undefined\n"
    )


@pytest.mark.asyncio
async def test_the_body_always_carries_a_timeout():
    with aioresponses() as m:
        m.post(EXTRACT, payload={"results": []})
        await run("tvly extract https://a --format text --query q")
        body = m.requests[("POST", URL(EXTRACT))][0].kwargs["json"]
    assert body == {
        "urls": ["https://a"],
        "query": "q",
        "format": "text",
        "timeout": 30,
    }


@pytest.mark.asyncio
async def test_a_given_timeout_is_the_one_sent():
    with aioresponses() as m:
        m.post(EXTRACT, payload={"results": []})
        await run("tvly extract https://a --timeout 5")
        body = m.requests[("POST", URL(EXTRACT))][0].kwargs["json"]
    assert body["timeout"] == 5


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "stderr"),
    [
        ("tvly extract", "error: missing required argument 'urls'\n"),
        (
            "tvly extract " + " ".join(f"u{i}" for i in range(21)),
            "error: Maximum 20 URLs per request.\n",
        ),
        (
            "tvly extract u --format html",
            "error: option '--format <format>' argument 'html' is invalid. "
            "Allowed choices are markdown, text.\n",
        ),
    ],
)
async def test_a_refused_line_answers_as_tvly_does(line, stderr):
    assert await run(line) == (2, "", stderr)
