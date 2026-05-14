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
import os
import uuid

import boto3
import pytest

from mirage.core.s3.write import write_bytes
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import DriftPolicy, MountMode
from mirage.workspace import Workspace
from mirage.workspace.snapshot import ContentDriftError

LIVE_BUCKET = os.environ.get("MIRAGE_LIVE_S3_BUCKET") or os.environ.get(
    "AWS_S3_BUCKET")
LIVE_REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
LIVE_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID")
LIVE_SECRET = os.environ.get("AWS_SECRET_ACCESS_KEY")

_LIVE_READY = bool(LIVE_BUCKET and LIVE_KEY_ID and LIVE_SECRET)

pytestmark = pytest.mark.skipif(
    not _LIVE_READY,
    reason=("set MIRAGE_LIVE_S3_BUCKET (or AWS_S3_BUCKET) plus "
            "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY to run live S3 tests"),
)


def _config() -> S3Config:
    return S3Config(
        bucket=LIVE_BUCKET,
        region=LIVE_REGION,
        aws_access_key_id=LIVE_KEY_ID,
        aws_secret_access_key=LIVE_SECRET,
    )


def _boto_client():
    return boto3.client(
        "s3",
        region_name=LIVE_REGION,
        aws_access_key_id=LIVE_KEY_ID,
        aws_secret_access_key=LIVE_SECRET,
    )


def _versioning_enabled() -> bool:
    try:
        resp = _boto_client().get_bucket_versioning(Bucket=LIVE_BUCKET)
    except Exception:
        return False
    return resp.get("Status") == "Enabled"


def _probe_key() -> str:
    return f"mirage-drift-probe-{uuid.uuid4().hex[:8]}.txt"


def _mount(prefix: str = "/s3/") -> dict:
    return {prefix: (S3Resource(_config()), MountMode.WRITE)}


def _override(prefix: str = "/s3/") -> dict:
    return {prefix: S3Resource(_config())}


def _cleanup_key(key: str) -> None:
    client = _boto_client()
    try:
        if _versioning_enabled():
            versions = client.list_object_versions(Bucket=LIVE_BUCKET,
                                                   Prefix=key).get(
                                                       "Versions", [])
            for v in versions:
                if v.get("Key") == key:
                    client.delete_object(Bucket=LIVE_BUCKET,
                                         Key=key,
                                         VersionId=v["VersionId"])
            markers = client.list_object_versions(Bucket=LIVE_BUCKET,
                                                  Prefix=key).get(
                                                      "DeleteMarkers", [])
            for m in markers:
                if m.get("Key") == key:
                    client.delete_object(Bucket=LIVE_BUCKET,
                                         Key=key,
                                         VersionId=m["VersionId"])
        else:
            client.delete_object(Bucket=LIVE_BUCKET, Key=key)
    except Exception:
        pass


def test_live_strict_raises_on_etag_drift(tmp_path):
    """Snapshot with a recorded read, mutate the live object via boto so
    its ETag changes, load with STRICT: the eager drift check must raise
    ContentDriftError before any user-visible read.

    Requires versioning OFF: on a versioned bucket, stat() captures a
    revision and STRICT installs a pin (which intentionally bypasses
    drift detection). That path is covered by the version-pin test.
    """
    if _versioning_enabled():
        pytest.skip(f"bucket {LIVE_BUCKET} is versioned; STRICT will pin "
                    "instead of drift-checking. See the version-pin test "
                    "for the versioned path.")
    key = _probe_key()
    probe = f"/s3/{key}"
    client = _boto_client()
    client.put_object(Bucket=LIVE_BUCKET, Key=key, Body=b"v1 bytes\n")
    try:
        src = Workspace(_mount(), mode=MountMode.WRITE)
        result = asyncio.run(src.execute(f"cat {probe}"))
        assert b"v1 bytes" in result.stdout

        snap = tmp_path / "drift.tar"
        asyncio.run(src.snapshot(snap))

        client.put_object(Bucket=LIVE_BUCKET, Key=key, Body=b"v2 mutated\n")

        dst = Workspace.load(snap, resources=_override())
        with pytest.raises(ContentDriftError) as exc_info:
            asyncio.run(dst.execute(f"cat {probe}"))
        assert exc_info.value.path == probe
        assert (exc_info.value.snapshot_fingerprint
                != exc_info.value.live_fingerprint)
    finally:
        _cleanup_key(key)


def test_live_no_drift_passes(tmp_path):
    """Control: snapshot + load with identical bytes on the bucket must
    succeed. Guards against false-positive drift on the live ETag path.
    """
    key = _probe_key()
    probe = f"/s3/{key}"
    client = _boto_client()
    client.put_object(Bucket=LIVE_BUCKET, Key=key, Body=b"stable\n")
    try:
        src = Workspace(_mount(), mode=MountMode.WRITE)
        asyncio.run(src.execute(f"cat {probe}"))

        snap = tmp_path / "stable.tar"
        asyncio.run(src.snapshot(snap))

        dst = Workspace.load(snap, resources=_override())
        result = asyncio.run(dst.execute(f"cat {probe}"))
        assert b"stable" in result.stdout
    finally:
        _cleanup_key(key)


def test_live_pin_records_agent_version_not_snapshot_time_version(tmp_path):
    """Race-fix regression test.

    Agent reads V1 at T1. Between T1 and snapshot at T3, an external
    actor mutates the object to V2. Old design (live stat at snapshot
    time) would capture V2's VersionId and pin replay to V2, serving
    bytes the agent never saw. New design records VersionId at READ
    time (from the GET response headers), so the snapshot pins to V1
    and serves V1 bytes on cache miss.

    Skipped on non-versioned buckets (no revision = no pin).
    """
    if not _versioning_enabled():
        pytest.skip("requires versioning")

    key = _probe_key()
    probe = f"/s3/{key}"
    client = _boto_client()
    client.put_object(Bucket=LIVE_BUCKET, Key=key, Body=b"v1\n")
    try:
        src = Workspace(_mount(), mode=MountMode.WRITE)
        result = asyncio.run(src.execute(f"cat {probe}"))
        assert b"v1" in result.stdout

        # Race: upstream changes BEFORE snapshot fires
        client.put_object(Bucket=LIVE_BUCKET, Key=key, Body=b"v2-racy\n")

        snap = tmp_path / "racy.tar"
        asyncio.run(src.snapshot(snap))

        dst = Workspace.load(snap, resources=_override())
        dst._cache.evict_paths([probe])
        result = asyncio.run(dst.execute(f"cat {probe}"))
        assert result.stdout == b"v1\n", (
            f"snapshot pinned the wrong VersionId; served {result.stdout!r} "
            "instead of the V1 the agent actually saw")
    finally:
        _cleanup_key(key)


def test_live_version_pin_serves_original_on_versioned_bucket(tmp_path):
    """End-to-end pin: with bucket versioning enabled, snapshot captures
    the live VersionId. After the bucket head moves on, STRICT load
    serves the original recorded bytes via the pin, not the current
    head, and does not raise.

    Skipped (xfail) when the bucket is not versioned; the pin path
    requires real S3 versioning to exercise.
    """
    if not _versioning_enabled():
        pytest.skip(
            f"bucket {LIVE_BUCKET} does not have versioning enabled; "
            "run `aws s3api put-bucket-versioning --bucket "
            f"{LIVE_BUCKET} --versioning-configuration Status=Enabled` "
            "to exercise the pin path")

    key = _probe_key()
    probe = f"/s3/{key}"
    client = _boto_client()
    client.put_object(Bucket=LIVE_BUCKET, Key=key, Body=b"original\n")
    try:
        src = Workspace(_mount(), mode=MountMode.WRITE)
        result = asyncio.run(src.execute(f"cat {probe}"))
        assert b"original" in result.stdout

        snap = tmp_path / "pin.tar"
        asyncio.run(src.snapshot(snap))

        client.put_object(Bucket=LIVE_BUCKET, Key=key, Body=b"mutated\n")

        dst = Workspace.load(snap, resources=_override())
        dst._cache.evict_paths([probe])
        result = asyncio.run(dst.execute(f"cat {probe}"))
        assert result.stdout == b"original\n", (
            "pinned read should serve the recorded version, "
            f"got {result.stdout!r}")
    finally:
        _cleanup_key(key)


def test_live_off_policy_serves_current(tmp_path):
    """drift_policy=OFF must skip both the drift check and any pin
    installation, evict the snapshot cache, and serve the live bytes.
    Smokes the regression where the pin was installed even when the
    caller explicitly asked for live state.
    """
    key = _probe_key()
    probe = f"/s3/{key}"
    client = _boto_client()
    client.put_object(Bucket=LIVE_BUCKET, Key=key, Body=b"original\n")
    try:
        src = Workspace(_mount(), mode=MountMode.WRITE)
        asyncio.run(src.execute(f"cat {probe}"))

        snap = tmp_path / "off.tar"
        asyncio.run(src.snapshot(snap))

        client.put_object(Bucket=LIVE_BUCKET, Key=key, Body=b"mutated\n")

        dst = Workspace.load(snap,
                             resources=_override(),
                             drift_policy=DriftPolicy.OFF)
        assert dst.revisions == {}
        result = asyncio.run(dst.execute(f"cat {probe}"))
        assert b"mutated" in result.stdout
    finally:
        _cleanup_key(key)


def test_live_stat_populates_revision_when_versioned(tmp_path):
    """Smoke: on a versioned bucket, S3Resource.stat must populate
    FileStat.revision so capture_fingerprints records it. Tightens the
    contract that downstream pin tests rely on.
    """
    if not _versioning_enabled():
        pytest.skip("bucket not versioned")
    key = _probe_key()
    probe = f"/s3/{key}"
    client = _boto_client()
    client.put_object(Bucket=LIVE_BUCKET, Key=key, Body=b"x\n")
    try:
        resource = S3Resource(_config())
        asyncio.run(write_bytes(resource.accessor, probe, b"x\n"))
        stat = asyncio.run(resource._ops["stat"](resource.accessor, probe))
        assert stat.fingerprint is not None
        assert stat.revision is not None, (
            "versioned bucket head should carry a VersionId")
    finally:
        _cleanup_key(key)
