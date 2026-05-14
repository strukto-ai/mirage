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

from mirage.observe import OpRecord
from mirage.workspace.types import ExecutionNode


def test_op_record_fields():
    r = OpRecord(
        op="read",
        path="/s3/data/file.csv",
        source="s3",
        bytes=1024,
        timestamp=1711800000000,
        duration_ms=150,
    )
    assert r.op == "read"
    assert r.path == "/s3/data/file.csv"
    assert r.source == "s3"
    assert r.bytes == 1024
    assert r.timestamp == 1711800000000
    assert r.duration_ms == 150
    assert r.fingerprint is None
    assert r.revision is None


def test_op_record_with_fingerprint():
    r = OpRecord(
        op="read",
        path="/s3/data/file.csv",
        source="s3",
        bytes=1024,
        timestamp=1711800000000,
        duration_ms=150,
        fingerprint="abc123",
    )
    assert r.fingerprint == "abc123"
    assert r.revision is None


def test_op_record_with_revision():
    r = OpRecord(
        op="read",
        path="/s3/data/file.csv",
        source="s3",
        bytes=1024,
        timestamp=1711800000000,
        duration_ms=150,
        revision="vL5_raa...",
    )
    assert r.revision == "vL5_raa..."
    assert r.fingerprint is None


def test_op_record_with_both():
    r = OpRecord(
        op="read",
        path="/s3/data/file.csv",
        source="s3",
        bytes=1024,
        timestamp=1711800000000,
        duration_ms=150,
        fingerprint="abc123",
        revision="vL5_raa...",
    )
    assert r.fingerprint == "abc123"
    assert r.revision == "vL5_raa..."


def test_op_record_zero_bytes():
    r = OpRecord(
        op="stat",
        path="/s3/data/file.csv",
        source="s3",
        bytes=0,
        timestamp=1711800000000,
        duration_ms=5,
    )
    assert r.bytes == 0


def test_execution_node_has_records():
    node = ExecutionNode(command="cat /s3/data/a.txt", exit_code=0)
    assert node.records == []


def test_execution_node_records_in_to_dict():
    from mirage.workspace.types import ExecutionNode

    r = OpRecord(
        op="read",
        path="/s3/a.txt",
        source="s3",
        bytes=100,
        timestamp=1711800000000,
        duration_ms=10,
    )
    node = ExecutionNode(command="cat /s3/a.txt", exit_code=0, records=[r])
    d = node.to_dict()
    assert len(d["records"]) == 1
    assert d["records"][0]["op"] == "read"
