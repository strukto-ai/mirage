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


@pytest.mark.asyncio
async def test_a_heredoc_body_expands_by_its_own_escapes():
    # The body rides in a double-quoted word, but a quote is plain text in
    # it and a backslash escapes only `$`, a backtick and itself.
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await ws.shell(
            'x=v; cat <<E\n"$x" \\"y\\" \\q \\$x \\\\ `echo t`\nE'
        )
        assert await io.stdout_str() == '"v" \\"y\\" \\q $x \\ t\n'
    finally:
        await ws.close()
