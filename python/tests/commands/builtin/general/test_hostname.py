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

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.builtin.general.hostname import USAGE


@pytest.mark.asyncio
async def test_a_display_option_with_a_name_is_the_usage_block():
    with Workspace({"/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        result = await ws.shell("hostname -s box")
        assert (result.exit_code, result.stdout) == (255, b"")
        assert await result.stderr_str() == USAGE
