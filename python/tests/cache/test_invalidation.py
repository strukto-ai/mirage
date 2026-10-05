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

from mirage.cache.invalidation import Invalidation


def test_a_removal_of_the_key_makes_the_stamp_stale():
    inv = Invalidation()
    stamp = inv.enter("/a")
    inv.invalidate("/a")
    assert inv.stale("/a", stamp)
    inv.leave("/a")


def test_a_removal_of_another_key_does_not():
    inv = Invalidation()
    stamp = inv.enter("/a")
    inv.invalidate("/b")
    assert not inv.stale("/a", stamp)
    inv.leave("/a")


def test_a_store_wide_invalidation_reaches_every_writer():
    inv = Invalidation()
    stamp = inv.enter("/a")
    inv.invalidate_all()
    assert inv.stale("/a", stamp)
    inv.leave("/a")


def test_a_removal_with_no_writer_in_flight_leaves_nothing_behind():
    inv = Invalidation()
    inv.invalidate("/a")
    assert inv._keys == {}
    stamp = inv.enter("/a")
    assert not inv.stale("/a", stamp)
    inv.leave("/a")
    assert inv._writers == {}


def test_the_last_writer_out_drops_the_key_counter():
    inv = Invalidation()
    first = inv.enter("/a")
    second = inv.enter("/a")
    inv.invalidate("/a")
    inv.leave("/a")
    assert inv.stale("/a", second)
    inv.leave("/a")
    assert inv._keys == {}
    # The counter reset, so a new writer's stamp is the first one again.
    # `not stale(...)` would pass with the counter left in place.
    assert first == inv.enter("/a")
    inv.leave("/a")


def test_a_prefix_invalidation_reaches_the_writers_under_it():
    inv = Invalidation()
    under = inv.enter("/a/x")
    deeper = inv.enter("/a/b/c")
    stamps = {key: inv.enter(key) for key in ("/b", "/a", "/ab/x")}
    inv.invalidate_prefix("/a/")
    assert inv.stale("/a/x", under)
    assert inv.stale("/a/b/c", deeper)
    for key, stamp in stamps.items():
        assert not inv.stale(key, stamp), key
    for key in ("/a/x", "/a/b/c", *stamps):
        inv.leave(key)
    assert inv._keys == {}


def test_a_prefix_invalidation_spares_an_excluded_root():
    inv = Invalidation()
    nested = inv.enter("/a/nested/f")
    root = inv.enter("/a/nested")
    sibling = inv.enter("/a/nested2")
    inv.invalidate_prefix("/a/", excluded=("/a/nested",))
    assert not inv.stale("/a/nested/f", nested)
    assert not inv.stale("/a/nested", root)
    assert inv.stale("/a/nested2", sibling)
    for key in ("/a/nested/f", "/a/nested", "/a/nested2"):
        inv.leave(key)
