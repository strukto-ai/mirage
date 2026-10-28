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

from mirage.cache.versions import VersionHistory, VersionScope
from mirage.observe.record import OpRecord
from mirage.workspace.session.session import SessionState


def record(op="read", version="v1"):
    return OpRecord(op, "/f", "s3", 1, 0, 0, fingerprint=version)


def test_histories_are_session_and_mount_owned():
    scope, replacement = VersionScope(), VersionScope()
    a, b = VersionHistory(), VersionHistory()
    a.observe(scope, "/f", record())
    b.observe(scope, "/f", record(version="v2"))
    assert a.read(scope, "/f") == "v1"
    assert b.read(scope, "/f") == "v2"
    assert a.read(replacement, "/f") is None


def test_stream_stamps_and_unknown_reads():
    history, scope = VersionHistory(), VersionScope()
    rec = record(version=None)
    history.observe(scope, "/f", rec)
    rec.fingerprint = "v1"
    assert history.read(scope, "/f") == "v1"
    history.observe(scope, "/f", record("stat", "v2"))
    assert history.read(scope, "/f") == "v1"
    history.observe(scope, "/f", record(version=None))
    assert history.read(scope, "/f") is None


@pytest.mark.parametrize(
    "op", ["unlink", "rename", "copy", "append", "pwrite"]
)
def test_point_mutation_does_not_retract_children(op):
    history, scope = VersionHistory(), VersionScope()
    history.observe(scope, "/f", record())
    history.observe(scope, "/f/child", record())
    history.observe(scope, "/f", record(op))
    assert history.read(scope, "/f") is None
    assert history.read(scope, "/f/child") == "v1"


def test_subtree_refusal_and_replay_pins():
    history, scope = VersionHistory(), VersionScope()
    scope.pins["/d/pinned"] = "snapshot"
    history.observe(scope, "/d/a", record())
    history.observe(scope, "/dog", record())
    history.observe(scope, "/d", record("rm_r"))
    history.keep(scope, "/d/a", "v1")
    assert history.read(scope, "/d/a") == "v1"
    assert history.read(scope, "/d/pinned") is None
    assert history.read(scope, "/dog") == "v1"
    history.keep(scope, "/d/a", None)
    assert history.read(scope, "/d/a") is None


def test_live_history_is_shared_by_shell_forks_but_not_serialized():
    session, scope = SessionState("a"), VersionScope()
    session.versions.observe(scope, "/f", record())
    assert session.fork().versions is session.versions
    assert session.subshell().versions is session.versions
    fields = session.to_dict()
    assert "versions" not in fields
    restored = SessionState.from_dict(fields)
    assert restored.versions.read(scope, "/f") is None


@pytest.mark.parametrize("initial", ["v1", None])
def test_unstarted_reads_preserve_the_previous_observation(initial):
    history, scope = VersionHistory(), VersionScope()
    scope.pins["/f"] = "snapshot"
    history.keep(scope, "/f", initial)
    for _ in range(3):
        pending = record(version=None)
        pending.bytes = 0
        history.observe(scope, "/f", pending)
        assert history.read(scope, "/f") == initial
    pending.fingerprint = "empty-file-token"
    assert history.read(scope, "/f") == "empty-file-token"
    pending = record(version=None)
    pending.bytes = 0
    history.observe(scope, "/f", pending)
    pending.bytes = 1
    assert history.read(scope, "/f") is None
