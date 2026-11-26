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

from mirage.observe import OpRecord
from mirage.observe.record import OpLog, RecordIndex
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


def test_internal_mount_identity_is_not_serialized():
    record = OpRecord(
        op="read",
        path="/data/file",
        source="s3",
        bytes=3,
        timestamp=1,
        duration_ms=2,
        fingerprint="fp",
        revision="v1",
        mount_id="internal-mount",
    )
    fields = record.to_dict()
    assert set(fields) == {
        "op",
        "path",
        "source",
        "bytes",
        "timestamp",
        "duration_ms",
        "fingerprint",
        "revision",
    }
    assert ExecutionNode(records=[record]).to_dict()["records"] == [fields]


def _op(op: str, path: str) -> OpRecord:
    return OpRecord(
        op=op, path=path, source="s3", bytes=0, timestamp=0, duration_ms=0
    )


@pytest.mark.parametrize(
    "ops, key, newest",
    [
        ([("read", "/a")], "/a", 0),
        ([("read", "/a"), ("write", "/a")], "/a", 1),
        ([("read", "/a"), ("stat", "/a")], "/a", 0),
        ([("read", "/d/a"), ("rm_r", "/d")], "/d/a", 1),
        ([("rm_r", "/d"), ("read", "/d/a")], "/d/a", 1),
        ([("read", "/d/a"), ("rm_r", "/dx")], "/d/a", 0),
        (
            [("read", "/d/a"), ("rename_prefix", "/d"), ("read", "/e")],
            "/d/a",
            1,
        ),
        ([("rm_r", "/d"), ("read", "/d/a"), ("rm_r", "/d")], "/d/a", 2),
        ([("read", "/b")], "/a", None),
    ],
    ids=[
        "a read",
        "the newer of two",
        "a stat counts for nothing",
        "a later subtree retract above",
        "a read after the retract",
        "a sibling prefix is not above",
        "a retract among others",
        "the later of two retracts",
        "nothing for the path",
    ],
)
def test_the_index_finds_the_newest_version_record(ops, key, newest):
    records = [_op(op, path) for op, path in ops]
    found = RecordIndex(records).newest_version(key)
    assert found is (records[newest] if newest is not None else None)


def test_the_index_reads_each_record_once():
    # Append-only: a lookup costs the records since the last one.
    records = [_op("read", "/a")]
    index = RecordIndex(records)
    index.newest_version("/a")
    records[0] = _op("read", "/b")
    assert index.newest_version("/b") is None


def test_the_op_log_drops_the_oldest_records_that_change_no_pin():
    def rec(op: str, source: str = "disk", fingerprint: str | None = None):
        return OpRecord(
            op=op,
            path="/data/" + op,
            source=source,
            bytes=10,
            timestamp=0,
            duration_ms=0,
            fingerprint=fingerprint,
        )

    # It trims once it took more than half of what its last trim kept.
    log = OpLog(max_records=4)
    stamp, gone, kept = rec("read", "s3", "etag"), rec("unlink"), rec("read")
    log.add([rec("read"), stamp, rec("stat", "ram"), gone, kept])
    assert len(log.records) == 5
    newest = [rec("read"), rec("readdir"), rec("stat")]
    log.add(newest[:2])
    assert len(log.records) == 7
    log.add(newest[2:])
    assert [id(r) for r in log.records] == [
        id(r) for r in (stamp, gone, *newest)
    ]
    assert (log.network_bytes, log.cache_bytes) == (70, 10)


# A later stamp of a path overrules the earlier ones of the same mount, a
# later drop the earlier drops there, and a later prefix op an earlier
# prefix op and drop there, so reading or writing a file again leaves one
# record of it. A stamp of another mount and a prefix op followed by a
# drop both stay, and a record that arrives late with an earlier time is
# overruled as it lands.
def test_the_op_log_drops_a_record_a_later_one_overrules():
    def rec(
        op: str,
        path: str,
        timestamp: int,
        fingerprint: str | None = None,
        mount_id: str | None = None,
    ) -> OpRecord:
        return OpRecord(
            op=op,
            path=path,
            source="s3",
            bytes=10,
            timestamp=timestamp,
            duration_ms=0,
            fingerprint=fingerprint,
            mount_id=mount_id,
        )

    def held() -> list[int]:
        return [id(r) for r in log.records]

    log = OpLog(max_records=3)
    read = rec("read", "/s3/a", 1, "v1")
    replaced = rec("read", "/s3/a", 2, "v1", "gone")
    appended = rec("append", "/s3/b", 3)
    swept = rec("rm_r", "/s3/c", 4)
    log.add([read, replaced, appended, swept])
    assert held() == [id(r) for r in (read, replaced, appended, swept)]
    again = rec("read", "/s3/a", 5, "v2")
    removed = rec("unlink", "/s3/b", 6)
    inside = rec("append", "/s3/c", 7)
    log.add([again, removed, inside, rec("read", "/s3/a", 0, "v0")])
    assert held() == [id(r) for r in (replaced, swept, again, removed, inside)]
    resweep = rec("rm_r", "/s3/c", 9)
    others = [rec("read", f"/s3/{name}", 10, "v") for name in "def"]
    log.add([resweep, *others])
    assert held() == [
        id(r) for r in (replaced, again, removed, resweep, *others)
    ]
    assert (log.network_bytes, log.cache_bytes) == (120, 0)
