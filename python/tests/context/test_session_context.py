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

from mirage.context import (assert_mount_allowed, effective_mount_mode,
                            get_current_session, reset_current_session,
                            set_current_session)
from mirage.types import MountMode, weaker_mode
from mirage.workspace.session import Session


@pytest.fixture
def bound_session():
    sess = Session(session_id="agent",
                   mount_modes={
                       "/ro": MountMode.READ,
                       "/rw": MountMode.WRITE,
                       "/ex": MountMode.EXEC,
                   })
    token = set_current_session(sess)
    yield sess
    reset_current_session(token)


def test_weaker_mode_lattice():
    assert weaker_mode(MountMode.READ, MountMode.WRITE) == MountMode.READ
    assert weaker_mode(MountMode.WRITE, MountMode.READ) == MountMode.READ
    assert weaker_mode(MountMode.EXEC, MountMode.WRITE) == MountMode.WRITE
    assert weaker_mode(MountMode.EXEC, MountMode.EXEC) == MountMode.EXEC


def test_no_session_is_unrestricted():
    assert get_current_session() is None
    assert_mount_allowed("/anything")
    assert effective_mount_mode("/anything", MountMode.WRITE) \
        == MountMode.WRITE


def test_unrestricted_session_keeps_mount_mode():
    token = set_current_session(Session(session_id="free"))
    try:
        assert_mount_allowed("/s3")
        assert effective_mount_mode("/s3", MountMode.EXEC) == MountMode.EXEC
    finally:
        reset_current_session(token)


def test_missing_grant_denies_visibility(bound_session):
    with pytest.raises(PermissionError, match="not allowed"):
        assert_mount_allowed("/other")


def test_root_mount_is_governed(bound_session):
    with pytest.raises(PermissionError, match="'/'"):
        assert_mount_allowed("/")


def test_grant_narrows_mount_mode(bound_session):
    assert effective_mount_mode("/ro", MountMode.WRITE) == MountMode.READ
    assert effective_mount_mode("/rw", MountMode.EXEC) == MountMode.WRITE


def test_grant_cannot_widen_mount_mode(bound_session):
    assert effective_mount_mode("/ex", MountMode.READ) == MountMode.READ
    assert effective_mount_mode("/rw", MountMode.READ) == MountMode.READ


def test_prefix_normalization(bound_session):
    assert_mount_allowed("/ro/")
    assert_mount_allowed("ro")
    assert effective_mount_mode("/ro/", MountMode.WRITE) == MountMode.READ


def test_missing_grant_defaults_effective_to_read(bound_session):
    assert effective_mount_mode("/other", MountMode.EXEC) == MountMode.READ
