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

from tests.e2e.s3_mock import MultiBucketS3Client


async def _put_bare(c: MultiBucketS3Client) -> None:
    await c.put_object(Bucket="b", Key="k", Body=b"attempt\n")


async def _delete_marker_then_file(c: MultiBucketS3Client) -> None:
    await c.delete_objects(
        Bucket="b", Delete={"Objects": [{"Key": "d/"}, {"Key": "d/a"}]}
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("call", [_put_bare, _delete_marker_then_file])
async def test_the_tripwire_refuses_an_unconditioned_mutation(call):
    # A no-op tripwire would let every tripwire row in the e2e suite pass.
    c = MultiBucketS3Client({"b": {"k": b"k\n", "d/": b"", "d/a": b"a"}})
    c.tripwire = True
    with pytest.raises(AssertionError, match="unconditioned"):
        await call(c)
