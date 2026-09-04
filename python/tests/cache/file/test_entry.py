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

import time

from mirage.cache.file.entry import CacheEntry


def test_cache_entry_creation():
    entry = CacheEntry(cached_at=int(time.time()), size=5)
    assert entry.fingerprint is None
    assert entry.size == 5


def test_cache_entry_mutable():
    entry = CacheEntry(cached_at=100, size=1)
    entry.cached_at -= 20
    assert entry.cached_at == 80


def test_expired_with_ttl():
    entry = CacheEntry(cached_at=1000, size=1, ttl=10)
    assert entry.is_expired(1010) is True


def test_not_expired_without_ttl():
    entry = CacheEntry(cached_at=1000, size=1)
    assert entry.ttl is None
    assert entry.is_expired(999_999) is False


def test_not_expired_within_ttl():
    entry = CacheEntry(cached_at=1000, size=1, ttl=3600)
    assert entry.is_expired(4599) is False


def test_expiry_is_read_at_the_boundary():
    entry = CacheEntry(cached_at=1000, size=1, ttl=10)
    assert entry.is_expired(1009) is False
    assert entry.is_expired(1010) is True
