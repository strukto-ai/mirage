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

from collections.abc import Callable, Iterator
from functools import partial

import pytest

from mirage.accessor.hf_buckets import HfBucketsAccessor
from tests.fixtures.hf_buckets_opendal import (BUCKET, FakeAsyncOperator,
                                               _FakeEntry, _FakeMetadata,
                                               make_accessor)
from tests.fixtures.hf_hub_api import FakeHub, serve

__all__ = [
    "BUCKET", "FakeAsyncOperator", "_FakeEntry", "_FakeMetadata",
    "make_accessor"
]


@pytest.fixture
def fake_hub() -> Iterator[FakeHub]:
    with serve(FakeHub()) as hub:
        yield hub


@pytest.fixture
def make_acc(fake_hub: FakeHub) -> Callable[..., HfBucketsAccessor]:
    return partial(make_accessor, hub=fake_hub)
