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

import json

import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage import Workspace
from mirage.commands.cli.builtin.tvly import TVLY
from mirage.io.types import materialize
from mirage.types import MountMode
from mirage.vfs.ram.ram import RAMVFS

SEARCH = "https://api.tavily.com/search"
ANSWER = {
    "query": "q",
    "answer": "An  answer.",
    "results": [
        {"title": "First", "url": "https://a.example", "content": "a  b\nc"},
        {"title": "", "url": "https://b.example", "content": ""},
    ],
    "images": ["https://img.example/1.png", {"url": "https://img.example/2"}],
}


async def run(line: str, config: dict | None = None) -> tuple[int, str, str]:
    """One line through a workspace with tvly installed, as an agent runs it."""
    ws = Workspace({"/work": RAMVFS()}, mode=MountMode.WRITE)
    ws.register_cli("tvly", TVLY, config or {"api_key": "tvly-k"})
    io = await ws.shell(line)
    out = (await materialize(io.stdout)).decode()
    err = (await materialize(io.stderr)).decode()
    await ws.close()
    return io.exit_code, out, err


@pytest.mark.asyncio
async def test_a_search_prints_tvlys_piped_text():
    with aioresponses() as m:
        m.post(SEARCH, payload=ANSWER)
        code, out, err = await run("tvly search q --max-chars 3")
    assert code == 0 and err == ""
    assert out == (
        "Answer: An  answer.\n\n"
        "1. First\nhttps://a.example\na b...\n\n"
        "2. Untitled\nhttps://b.example\n\n"
        "Image: https://img.example/1.png\n"
        "Image: https://img.example/2\n"
    )


@pytest.mark.asyncio
async def test_the_options_fill_the_body_in_the_sdk_catalogs_order():
    with aioresponses() as m:
        m.post(SEARCH, payload={"results": []})
        code, out, _ = await run(
            "tvly search q --time-range week --max-results 2 --depth fast "
            "--include-answer --include-domains a.com,,b.com"
        )
        body = m.requests[("POST", URL(SEARCH))][0].kwargs["json"]
    assert code == 0 and out == "No results found.\n"
    assert list(body) == [
        "query",
        "search_depth",
        "max_results",
        "include_answer",
        "include_domains",
        "time_range",
    ]
    assert body["include_answer"] == "basic"
    assert body["include_domains"] == ["a.com", "b.com"]


@pytest.mark.asyncio
async def test_json_prints_the_answer_unchanged():
    with aioresponses() as m:
        m.post(SEARCH, payload={"results": [], "response_time": 1.0})
        code, out, _ = await run("tvly search q --json")
    assert code == 0
    assert out == '{\n  "results": [],\n  "response_time": 1\n}\n'


@pytest.mark.asyncio
async def test_several_queries_print_under_headers_from_each_answer():
    found = {"query": "one", "results": [{"title": "T", "url": "u"}]}
    with aioresponses() as m:
        m.post(SEARCH, payload=found)
        m.post(SEARCH, status=500, payload={"detail": {"error": "boom"}})
        code, out, _ = await run("tvly search one two")
    assert code == 0
    assert out == ("=== [1/2] one\n1. T\nu\n\n=== [2/2] two\nerror: boom\n\n")


@pytest.mark.asyncio
async def test_every_query_failing_exits_as_the_last_failure_class():
    with aioresponses() as m:
        m.post(SEARCH, status=500, payload={"detail": {"error": "boom"}})
        m.post(SEARCH, status=500, payload={"detail": {"error": "boom"}})
        code, out, _ = await run("tvly search one two")
    assert code == 4
    assert out.count("error: boom") == 2


@pytest.mark.asyncio
async def test_a_query_from_stdin_with_a_dash():
    with aioresponses() as m:
        m.post(SEARCH, payload={"results": []})
        code, _, _ = await run("echo '  piped query  ' | tvly search -")
        body = m.requests[("POST", URL(SEARCH))][0].kwargs["json"]
    assert code == 0
    assert body["query"] == "piped query"


@pytest.mark.asyncio
async def test_dash_o_saves_the_json_and_still_prints_the_text():
    with aioresponses() as m:
        m.post(SEARCH, payload={"results": [{"title": "T", "url": "u"}]})
        code, out, err = await run(
            "cd /work && tvly search q -o r/s.json && cat r/s.json"
        )
    assert code == 0
    assert err == "Output saved to r/s.json\n"
    assert out.startswith("1. T\nu\n\n")
    assert json.loads(out.split("\n\n", 1)[1]) == {
        "results": [{"title": "T", "url": "u"}]
    }


@pytest.mark.asyncio
async def test_a_bare_dash_o_names_its_file_under_dot_tavily():
    with aioresponses() as m:
        m.post(SEARCH, payload={"results": []})
        code, out, err = await run(
            "cd /work && tvly search 'Hello World' -o --json && ls -A .tavily"
            " && cat .tavily/.gitignore"
        )
    assert code == 0
    assert err.startswith("Output saved to .tavily/search-hello-world-")
    assert out.startswith(".gitignore\nsearch-hello-world-")
    assert out.endswith(".json\n*\n")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "stderr"),
    [
        (
            "tvly search",
            "error: QUERY is required. Pass a query string or use '-' to "
            "read from stdin.\n",
        ),
        (
            "tvly search a b c d e f",
            "error: At most 5 queries per command, got 6.\n",
        ),
        (
            "tvly search q --depth x",
            "error: option '--depth <value>' argument 'x' is invalid. "
            "Allowed choices are basic, advanced, fast, ultra-fast.\n",
        ),
        (
            "tvly search q --include-answer maybe",
            "error: option '--include-answer [value]' argument 'maybe' is "
            "invalid. Allowed choices are basic, advanced, false, true.\n",
        ),
        (
            "tvly search q --max-results 30",
            "error: option '--max-results <n>' argument '30' is invalid. "
            "30 is above the maximum 20.\n",
        ),
    ],
)
async def test_a_refused_line_answers_as_tvly_does(line, stderr):
    code, out, err = await run(line)
    assert (code, out, err) == (2, "", stderr)
