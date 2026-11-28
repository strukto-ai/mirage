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

from mirage import Workspace
from mirage.commands.cli.builtin.tvly import TVLY
from mirage.commands.cli.specs import cli_spec_for
from mirage.io.types import materialize


async def run(line: str) -> tuple[int, str, str]:
    """One line through a workspace with a keyed tvly installed."""
    ws = Workspace({})
    ws.register_cli("tvly", TVLY, {"api_key": "tvly-k"})
    io = await ws.shell(line)
    out = (await materialize(io.stdout)).decode()
    err = (await materialize(io.stderr)).decode()
    await ws.close()
    return io.exit_code, out, err


def test_tvly_resolves_by_name():
    assert cli_spec_for("tvly") is TVLY


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "stderr"),
    [
        ("tvly search q --foo", "error: unknown option '--foo'\n"),
        (
            "tvly search q --dept basic",
            "error: unknown option '--dept'\n(Did you mean --depth?)\n",
        ),
        (
            "tvly search q --json=x",
            "error: unknown option '--json=x'\n(Did you mean --json?)\n",
        ),
        (
            "tvly --jso search q",
            "error: unknown option '--jso'\n(Did you mean --json?)\n",
        ),
        ("tvly search q -x", "error: unknown option '-x'\n"),
        (
            "tvly search q --max-results",
            "error: option '--max-results <n>' argument missing\n",
        ),
        (
            "tvly frob a",
            "error: too many arguments. Expected 0 arguments but got 2: "
            "frob, a.\n",
        ),
    ],
)
async def test_a_refusal_answers_in_commanders_words(line, stderr):
    assert await run(line) == (2, "", stderr)


@pytest.mark.asyncio
async def test_no_long_option_abbreviates():
    code, _, err = await run("tvly search q --max-res 2")
    assert code == 2
    assert err.startswith("error: unknown option '--max-res'\n")


@pytest.mark.asyncio
async def test_help_lists_every_verb():
    code, out, _ = await run("tvly --help")
    assert code == 0
    for verb in ("auth", "search", "extract", "crawl", "map", "research"):
        assert f"  {verb}" in out
