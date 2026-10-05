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

from mirage.core.hierarchy.search import query_matcher
from mirage.vfs.types import SearchQuery


@pytest.mark.parametrize(
    "pattern, syntax, line, expected",
    [
        ("caf.$", "extended", "café", False),
        ("caf..$", "extended", "café", True),
        ("\udca9$", "extended", "café", True),
        ("[[:alpha:]]$", "basic", "café", False),
        ("caf.$", "rust", "café", True),
        ("\\w$", "rust", "café", True),
    ],
)
def test_a_line_is_decided_as_the_scan_decides_it(
    pattern, syntax, line, expected
):
    query = SearchQuery(
        pattern, options={"grep": {"fixed_string": False, "syntax": syntax}}
    )
    assert query_matcher(query)(line) is expected
