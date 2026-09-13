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

from mirage.cache.file.utils import (default_fingerprint, glob_escape,
                                     parse_limit)


def test_parse_limit_bytes():
    assert parse_limit(1024) == 1024


def test_parse_limit_kb():
    assert parse_limit("1KB") == 1024


def test_parse_limit_mb():
    assert parse_limit("512MB") == 536870912


def test_parse_limit_gb():
    assert parse_limit("1GB") == 1073741824


def test_parse_limit_lowercase():
    assert parse_limit("10mb") == 10485760


def test_parse_limit_plain_string():
    assert parse_limit("1024") == 1024


def test_default_fingerprint():
    fp = default_fingerprint(b"hello")
    assert isinstance(fp, str)
    assert len(fp) == 32


def test_default_fingerprint_deterministic():
    assert default_fingerprint(b"same") == default_fingerprint(b"same")


def test_default_fingerprint_different_data():
    assert default_fingerprint(b"a") != default_fingerprint(b"b")


def test_glob_escape_leaves_an_ordinary_path_alone():
    assert glob_escape("/data/") == "/data/"


def test_glob_escape_neutralizes_redis_match_metacharacters():
    """A mount prefix is a path, and a path may hold the characters SCAN
    reads as wildcards."""
    assert glob_escape("/da[1]*a?/") == "/da\\[1\\]\\*a\\?/"


def test_glob_escape_escapes_the_escape_character():
    assert glob_escape("a\\b") == "a\\\\b"


@pytest.mark.asyncio
async def test_incremental_fingerprint_matches_native():
    import hashlib

    from mirage.cache.file.utils import default_fingerprint_async

    for size in (0, 55, 56, 64, 65, 16383, 16384, 16385, 100_000):
        data = b"x" * size
        assert await default_fingerprint_async(data) == hashlib.md5(
            data).hexdigest()
