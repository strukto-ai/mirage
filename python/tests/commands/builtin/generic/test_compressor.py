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

from mirage.workspace.lookup.constants import line_facts


@pytest.mark.parametrize(
    "words,writes",
    [
        (["xz", "-t", "/d/a"], False),
        (["xz", "-t", "-z", "/d/a"], True),
        (["xz", "-z", "-t", "/d/a"], False),
        (["xz", "-t", "-d", "/d/a"], True),
        (["xz", "-c", "-t", "-z", "/d/a"], False),
        (["bzip2", "-t", "-z", "/d/a"], True),
        (["bzip2", "-z", "-t", "/d/a"], False),
    ],
)
def test_the_last_mode_decides_whether_a_line_writes(words, writes):
    assert line_facts(words[0], words, "/").writes is writes
