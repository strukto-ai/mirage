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

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.watch import S3EventHook
from mirage.types import FileChangeKind, PathSpec
from mirage.vfs.s3.config import S3Config

ROOT = PathSpec.from_str_path("/s3", vfs_path="")


def _record(bucket: str, key: str) -> dict[str, dict[str, dict[str, str]]]:
    return {"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}


@pytest.mark.asyncio
async def test_records_map_onto_the_mount():
    # A key is URL-encoded with + for a space; one the hook has mapped is
    # an UPDATE, a marker removed leaves its directory UNKNOWN, and a
    # record for another bucket or outside the key prefix maps nothing.
    hook = S3EventHook(S3Accessor(S3Config(bucket="b", key_prefix="data/")))
    records = [
        ("ObjectCreated:Put", _record("b", "data/a+b%2B.txt")),
        (
            "ObjectCreated:CompleteMultipartUpload",
            _record("b", "data/a+b%2B.txt"),
        ),
        ("ObjectRemoved:Delete", _record("b", "data/a+b%2B.txt")),
        ("ObjectCreated:Put", _record("other", "data/x")),
        ("ObjectCreated:Put", _record("b", "logs/x")),
        ("ObjectCreated:Put", _record("b", "data/dir/")),
        ("ObjectRemoved:DeleteMarkerCreated", _record("b", "data/dir/")),
    ]
    pairs = [
        (event.kind, event.path.virtual)
        for name, record in records
        for event in await hook.to_events(ROOT, name, record)
    ]
    assert pairs == [
        (FileChangeKind.CREATE, "/s3/a b+.txt"),
        (FileChangeKind.UPDATE, "/s3/a b+.txt"),
        (FileChangeKind.DELETE, "/s3/a b+.txt"),
        (FileChangeKind.CREATE, "/s3/dir"),
        (FileChangeKind.UNKNOWN, "/s3/dir"),
    ]
