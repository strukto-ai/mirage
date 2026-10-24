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

import re

from mirage.core.gridfs.client import (
    _key,
    prefix_query,
    trashed,
)
from mirage.vfs.gridfs.config import GridFSConfig


def _config(key_prefix: str | None = None) -> GridFSConfig:
    return GridFSConfig(
        uri="mongodb://localhost:27017",
        database="db",
        bucket="data",
        key_prefix=key_prefix,
    )


def test_key_without_prefix():
    assert _key("/a.txt", _config()) == "a.txt"
    assert _key("/sub/b.csv", _config()) == "sub/b.csv"


def test_key_with_prefix():
    config = _config("team/reports")
    assert _key("/a.txt", config) == "team/reports/a.txt"


def test_prefix_query_empty_matches_everything_but_the_trash():
    pattern = prefix_query("")["filename"]["$regex"]
    assert re.match(pattern, "a.txt")
    assert re.match(pattern, "team/a.txt")
    assert not re.match(pattern, trashed("a.txt"))


def test_prefix_query_on_a_prefix_cannot_reach_the_trash():
    # No mount key starts with a slash, so a scoped query never does.
    pattern = prefix_query("team/")["filename"]["$regex"]
    assert not re.match(pattern, trashed("team/a.txt"))


def test_trashed_keeps_the_whole_key():
    assert trashed("team/reports/a.txt") == "/trash/team/reports/a.txt"


def test_prefix_query_escapes_regex_metachars():
    query = prefix_query("a+b (1)/")
    pattern = query["filename"]["$regex"]
    assert pattern.startswith("^")
    assert re.match(pattern, "a+b (1)/x.txt")
    assert not re.match(pattern, "aab (1)/x.txt")
