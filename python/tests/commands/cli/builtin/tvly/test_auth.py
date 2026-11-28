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
from mirage.io.types import materialize


async def run(line: str, config: dict) -> tuple[int, str]:
    """One line through a workspace with tvly installed under ``config``."""
    ws = Workspace({})
    ws.register_cli("tvly", TVLY, config)
    io = await ws.shell(line)
    out = (await materialize(io.stdout)).decode()
    await ws.close()
    return io.exit_code, out


@pytest.mark.asyncio
async def test_a_keyed_install_says_so_without_any_of_the_key():
    code, out = await run("tvly auth", {"api_key": "tvly-secret-value"})
    assert code == 0
    assert "secret" not in out
    assert out == (
        "\n  > Authenticated via the tvly install's api_key\n    Key: ***\n\n"
    )


@pytest.mark.asyncio
async def test_a_keyless_install_says_the_config_sets_no_key():
    code, out = await run("tvly auth", {})
    assert code == 0
    assert out == (
        "\n  > Not authenticated\n\n"
        "  No api_key is set in this tvly install's config.\n\n"
    )


@pytest.mark.asyncio
async def test_a_keyless_install_answers_unauthenticated_in_json():
    code, out = await run("tvly auth --json", {})
    assert code == 0
    assert out == '{"authenticated":false,"method":null,"source":null}\n'
