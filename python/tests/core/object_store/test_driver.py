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

import dataclasses

import pytest

from mirage.core.object_store.driver import (ChildEntry, FindHints, ObjectMeta,
                                             TreeEntry)
from tests.core.object_store.conftest import FakeStore, make_driver


def test_driver_is_frozen():
    driver = make_driver(FakeStore())
    with pytest.raises(dataclasses.FrozenInstanceError):
        driver.vfs = "other"  # type: ignore[misc]


def test_find_tree_defaults_to_none():
    assert make_driver(FakeStore()).find_tree is None
    assert make_driver(FakeStore(), find_narrowing=True).find_tree is not None


def test_entry_defaults():
    assert ChildEntry(key="k", kind="f").size is None
    assert TreeEntry(key="k").size == 0
    meta = ObjectMeta(size=1)
    assert meta.extra == {}
    assert FindHints(name=None,
                     iname=None,
                     type=None,
                     min_size=None,
                     max_size=None,
                     pushdown=False).pushdown is False
