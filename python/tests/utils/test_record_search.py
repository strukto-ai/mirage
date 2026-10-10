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

from mirage.utils.record_search import record_queries

KEYS = frozenset({"subject", "body_text", "flags", "true", "seen"})


@pytest.mark.parametrize(
    "text, whole_word, queries",
    [
        ("plan", False, ["plan"]),
        ("plan review", True, ["plan review"]),
        ("nice", True, ["nice", "ice"]),
        ("budget", False, ["udget"]),
        ("n cat", True, ["n cat", "cat"]),
        ("subject", True, None),
        ("ject", False, None),
        ("ject", True, ["ject"]),
        ("ject plan", False, ["ject plan"]),
        ("Seen", True, None),
        ("beef", True, None),
        ("deploy 42", True, None),
        ('say "hi"', False, None),
        ("caf\u00e9", False, None),
        ("back\\slash", False, None),
        ("   ", False, None),
    ],
)
def test_a_search_covers_every_record_the_text_may_match(
    text, whole_word, queries
):
    # Digits, quotes, escapes and non-ASCII can match an id, a count or a
    # JSON escape; a key, a fixed value or a hex run can match outside the
    # text the provider searches, and so can a substring of a key. A text
    # starting with a letter an escape ends with (\n, \b, \u001b) is
    # searched without that letter too.
    assert record_queries(text, KEYS, whole_word) == queries
