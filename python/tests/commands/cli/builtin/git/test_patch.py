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

from mirage.commands.cli.builtin.git.patch import whole_chars


# Pinned against git 2.47.3: a hunk header's function name loses the UTF-8
# sequence its cut leaves short, a lone lead byte included.
@pytest.mark.parametrize(
    ("data", "kept"),
    [
        (b"A" * 79 + "가".encode()[:1], b"A" * 79),
        (b"A" * 78 + "가".encode()[:2], b"A" * 78),
        (b"A" * 77 + "가".encode(), b"A" * 77 + "가".encode()),
        (b"A" * 78 + "😀".encode()[:2], b"A" * 78),
        (b"A" * 10 + b"\xe9", b"A" * 10),
        (b"plain", b"plain"),
        (b"", b""),
    ],
)
def test_a_cut_character_is_dropped(data: bytes, kept: bytes) -> None:
    assert whole_chars(data) == kept
