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

from mirage.accessor.gridfs import GridFSConfig
from mirage.core.gridfs._client import (_key, _prefix, _strip_prefix,
                                        prefix_query)


def _config(key_prefix: str | None = None) -> GridFSConfig:
    return GridFSConfig(uri="mongodb://localhost:27017",
                        database="db",
                        bucket="data",
                        key_prefix=key_prefix)


def test_key_without_prefix():
    assert _key("/a.txt", _config()) == "a.txt"
    assert _key("/sub/b.csv", _config()) == "sub/b.csv"


def test_key_with_prefix():
    config = _config("team/reports")
    assert _key("/a.txt", config) == "team/reports/a.txt"


def test_prefix_dir_form():
    assert _prefix("/sub", _config()) == "sub/"
    assert _prefix("/", _config()) == ""
    assert _prefix("/sub", _config("team")) == "team/sub/"


def test_strip_prefix_roundtrip():
    config = _config("team/reports")
    key = _key("/sub/a.txt", config)
    assert _strip_prefix(key, config) == "sub/a.txt"


def test_prefix_query_empty_matches_everything():
    assert prefix_query("") == {}


def test_prefix_query_escapes_regex_metachars():
    query = prefix_query("a+b (1)/")
    pattern = query["filename"]["$regex"]
    assert pattern.startswith("^")
    assert re.match(pattern, "a+b (1)/x.txt")
    assert not re.match(pattern, "aab (1)/x.txt")
