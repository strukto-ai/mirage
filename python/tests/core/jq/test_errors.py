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

from mirage.core.jq.errors import load_failure


@pytest.mark.parametrize(
    "exc, expected",
    [
        (
            FileNotFoundError("f"),
            "Could not open f: No such file or directory",
        ),
        (PermissionError("f"), "Could not open f: Permission denied"),
        (IsADirectoryError("f"), "Could not open f: It's a directory"),
    ],
)
def test_load_failure_words_a_file_jq_could_not_load(exc, expected):
    assert load_failure("f", exc) == expected
