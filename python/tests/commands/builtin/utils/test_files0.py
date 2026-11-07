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

from mirage.commands.builtin.utils.files0 import listed_names
from mirage.types import PathSpec


def _reader(data: bytes, size: int = 3):
    async def stream(path):
        for at in range(0, len(data), size):
            yield data[at : at + size]

    return stream


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data, names",
    [
        (b"a\0bc\0", ["a", "bc"]),
        (b"a\0bc", ["a", "bc"]),
        (b"a\0\0b\0", ["a", "", "b"]),
        (b"", []),
    ],
)
async def test_names_end_at_a_nul_and_the_last_may_lack_one(data, names):
    listed = await listed_names(PathSpec.from_str_path("/l"), _reader(data))
    assert listed == names


@pytest.mark.asyncio
async def test_a_failed_read_propagates():
    async def stream(path):
        raise FileNotFoundError(2, "No such file or directory")
        yield b""

    with pytest.raises(FileNotFoundError):
        await listed_names(PathSpec.from_str_path("/l"), stream)
