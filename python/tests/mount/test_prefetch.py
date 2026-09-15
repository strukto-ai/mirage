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

from mirage.mount.prefetch import PREFETCH_TTL, PrefetchCache


def test_a_stored_entry_reads_back():
    cache = PrefetchCache()
    cache.put("/a.txt", b"hello")

    assert cache.get("/a.txt") == b"hello"


def test_an_unknown_path_is_none():
    assert PrefetchCache().get("/nope") is None


def test_an_expired_entry_is_dropped_rather_than_returned():
    # A zero TTL expires the moment it is stored, which is what the
    # release-then-stat window looks like once it has closed.
    cache = PrefetchCache(ttl=0.0)
    cache.put("/a.txt", b"hello")

    assert cache.get("/a.txt") is None
    # dropped, not merely hidden: a second read does not resurrect it
    assert cache.get("/a.txt") is None


def test_invalidate_forgets_named_paths_and_tolerates_unknown_ones():
    cache = PrefetchCache()
    cache.put("/a.txt", b"a")
    cache.put("/b.txt", b"b")

    cache.invalidate("/a.txt", "/never-stored")

    assert cache.get("/a.txt") is None
    assert cache.get("/b.txt") == b"b"


def test_clear_forgets_everything():
    cache = PrefetchCache()
    cache.put("/a.txt", b"a")
    cache.put("/b.txt", b"b")

    cache.clear()

    assert (cache.get("/a.txt"), cache.get("/b.txt")) == (None, None)


def test_the_default_ttl_is_the_documented_window():
    # The number is a contract with the TS twin, not an implementation
    # detail: both windows have to be the same or a mount answers
    # differently depending on which language served it.
    cache = PrefetchCache()
    before = time.monotonic()
    cache.put("/a.txt", b"a")
    expires = cache._entries["/a.txt"][1]

    assert PREFETCH_TTL == 30.0
    assert expires - before >= PREFETCH_TTL
