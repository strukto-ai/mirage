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

from mirage.cache.file.utils import glob_escape


def test_glob_escape_leaves_an_ordinary_path_alone():
    assert glob_escape("/data/") == "/data/"


def test_glob_escape_neutralizes_redis_match_metacharacters():
    """A mount prefix is a path, and a path may hold the characters SCAN
    reads as wildcards."""
    assert glob_escape("/da[1]*a?/") == "/da\\[1\\]\\*a\\?/"


def test_glob_escape_escapes_the_escape_character():
    assert glob_escape("a\\b") == "a\\\\b"
