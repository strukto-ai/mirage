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

import asyncio

from mirage.accessor.s3 import S3Accessor
from mirage.ops.s3.identity import live_identity
from mirage.resource.s3 import S3Config
from mirage.types import PathSpec
from tests.e2e.s3_mock import patch_s3_multi

BUCKET = "test-bucket"


class _PoisonIndex:
    """An index cache that fails loudly if the op ever consults it."""

    def __getattr__(self, name):
        raise AssertionError(f"live_identity must not touch index.{name}")


def _path(p: str) -> PathSpec:
    return PathSpec(virtual=p, directory=p, resource_path=p.strip("/"))


def test_live_identity_ignores_a_poisoned_index():
    store = {BUCKET: {"foo.txt": b"hello"}}
    with patch_s3_multi(store):
        accessor = S3Accessor(
            S3Config(
                bucket=BUCKET,
                region="us-east-1",
                aws_access_key_id="fake",
                aws_secret_access_key="fake",
            ))
        result = asyncio.run(
            live_identity(accessor, _path("/foo.txt"), index=_PoisonIndex()))
    assert result.exists is True
    assert result.fingerprint is not None
