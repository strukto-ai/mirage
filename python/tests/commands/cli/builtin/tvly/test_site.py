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
from mirage.types import MountMode
from mirage.vfs.ram.ram import RAMVFS

CRAWL = "https://api.tavily.com/crawl"
MAP = "https://api.tavily.com/map"


async def run(line: str, config: dict | None = None) -> tuple[int, str, str]:
    """One line through a workspace with tvly installed and /work writable."""
    ws = Workspace({"/work": RAMVFS()}, mode=MountMode.WRITE)
    ws.register_cli(
        "tvly", TVLY, {"api_key": "tvly-k"} if config is None else config
    )
    io = await ws.shell(line)
    out = (await materialize(io.stdout)).decode()
    err = (await materialize(io.stderr)).decode()
    await ws.close()
    return io.exit_code, out, err


@pytest.mark.asyncio
async def test_map_prints_one_url_a_line():
    with aioresponses() as m:
        m.post(MAP, payload={"results": ["https://a/", "https://a/b"]})
        code, out, _ = await run("tvly map https://a --limit 2")
        body = m.requests[("POST", URL(MAP))][0].kwargs["json"]
    assert code == 0 and out == "https://a/\nhttps://a/b\n"
    assert body == {"url": "https://a", "limit": 2, "timeout": 150}


@pytest.mark.asyncio
async def test_the_site_filters_reach_the_body_as_lists():
    with aioresponses() as m:
        m.post(MAP, payload={"results": []})
        await run(
            "tvly map https://a --select-paths '/docs/.*, /blog/.*' "
            "--allow-external --no-external"
        )
        body = m.requests[("POST", URL(MAP))][0].kwargs["json"]
    assert body["select_paths"] == ["/docs/.*", "/blog/.*"]
    assert body["allow_external"] is False


@pytest.mark.asyncio
async def test_a_crawl_saves_each_page_under_its_slug():
    pages = {
        "results": [
            {"url": "https://a.example/guide/", "raw_content": "one"},
            {"url": "https://a.example/Guide", "raw_content": "two"},
            {"url": "https://a.example/empty", "raw_content": ""},
        ]
    }
    with aioresponses() as m:
        m.post(CRAWL, payload=pages)
        code, out, err = await run(
            "cd /work && tvly crawl https://a.example --output-dir pages && "
            "ls pages && cat pages/a.example_guide.md"
        )
    assert code == 0
    assert err == "Saved 2 pages to pages/\n"
    assert out == (
        "a.example_Guide-2.md\na.example_guide.md\n# https://a.example/guide/\n\none\n"
    )


@pytest.mark.asyncio
async def test_crawl_and_map_need_a_key_the_config_sets():
    assert await run("tvly map https://a", config={}) == (
        3,
        "",
        "\n  > The map command requires a Tavily API key.\n\n"
        "  No api_key is set in this tvly install's config.\n\n"
        "  Tip: tvly search and tvly extract work without an API key "
        "(subject to a rate-limit cap).\n\n",
    )


@pytest.mark.asyncio
async def test_more_than_one_start_is_refused():
    assert await run("tvly crawl a b") == (
        2,
        "",
        "error: too many arguments for 'crawl'. Expected 1 argument but got "
        "2: a, b.\n",
    )
