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

from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.types import PathSpec


def _ops(mounted: bool) -> CommandIO:

    async def readdir(_accessor, path, _index):
        return ["/a.txt", "/b.txt"]

    async def unused(*_args):
        raise AssertionError("not used")

    return CommandIO(readdir=readdir,
                     read_bytes=unused,
                     read_stream=unused,
                     stat=unused,
                     is_mounted=lambda _a: mounted)


@pytest.mark.asyncio
async def test_resolve_or_empty_expands_globs():
    spec = PathSpec(virtual="/*.txt",
                    directory="/",
                    resource_path="*.txt",
                    pattern="*.txt",
                    resolved=False)
    resolved = await resolve_or_empty(_ops(True), None, [spec], None)
    assert [p.virtual for p in resolved] == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_resolve_or_empty_unmounted_means_stdin_mode():
    resolved = await resolve_or_empty(_ops(False), None,
                                      [PathSpec.from_str_path("/a.txt")], None)
    assert resolved == []


@pytest.mark.asyncio
async def test_resolve_or_empty_no_paths():
    assert await resolve_or_empty(_ops(True), None, [], None) == []
