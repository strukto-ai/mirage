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

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import pytest_asyncio

from mirage.accessor.hf_buckets import HfBucketsAccessor
from tests.fixtures.hf_bucket import OWN, HfBucket, bucket

__all__ = ["bucket"]


@pytest_asyncio.fixture
async def make_acc(
    bucket: HfBucket,
) -> AsyncIterator[Callable[..., Awaitable[HfBucketsAccessor]]]:
    """An accessor on the test's bucket after another client wrote
    ``files`` to it, the requests recorded from then on.

    Each accessor owns an HTTP pool; close them on the loop that opened
    them, so no session outlives its test.

    Args:
        bucket (HfBucket): the test's bucket.
    """
    made: list[HfBucketsAccessor] = []

    async def build(
        files: dict[str, bytes] | None = None,
        *,
        key_prefix: str | None = None,
        token: Any = OWN,
    ) -> HfBucketsAccessor:
        for key, data in (files or {}).items():
            await bucket.write(key, data)
        await bucket.run.record_requests()
        acc = bucket.accessor(key_prefix, token)
        made.append(acc)
        return acc

    yield build
    for acc in made:
        await acc.close()
