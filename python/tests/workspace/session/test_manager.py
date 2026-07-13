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

import pytest

from mirage.types import MountMode
from mirage.workspace.session import SessionManager


def _run(coro):
    return asyncio.run(coro)


def test_manager_default_session():
    mgr = SessionManager("default")
    s = mgr.get("default")
    assert s.session_id == "default"


def test_manager_default_cwd():
    mgr = SessionManager("default")
    assert mgr.cwd == "/"
    mgr.cwd = "/data"
    assert mgr.cwd == "/data"
    assert mgr.get("default").cwd == "/data"


def test_manager_default_env():
    mgr = SessionManager("default")
    assert mgr.env == {}
    mgr.env = {"A": "1"}
    assert mgr.env == {"A": "1"}
    assert mgr.get("default").env == {"A": "1"}


def test_manager_create_session():
    mgr = SessionManager("default")
    s = mgr.create("worker-1")
    assert s.session_id == "worker-1"
    assert mgr.get("worker-1") is s


def test_manager_create_duplicate_raises():
    mgr = SessionManager("default")
    mgr.create("s1")
    with pytest.raises(ValueError, match="already exists"):
        mgr.create("s1")


def test_manager_get_missing_raises():
    mgr = SessionManager("default")
    with pytest.raises(KeyError):
        mgr.get("nonexistent")


def test_manager_list_sessions():
    mgr = SessionManager("default")
    mgr.create("s1")
    mgr.create("s2")
    sessions = mgr.list()
    ids = {s.session_id for s in sessions}
    assert ids == {"default", "s1", "s2"}


def test_manager_close_session():
    mgr = SessionManager("default")
    mgr.create("temp")
    _run(mgr.close("temp"))
    with pytest.raises(KeyError):
        mgr.get("temp")


def test_manager_close_default_raises():
    mgr = SessionManager("default")
    with pytest.raises(ValueError, match="Cannot close"):
        _run(mgr.close("default"))


def test_manager_close_missing_raises():
    mgr = SessionManager("default")
    with pytest.raises(KeyError):
        _run(mgr.close("nonexistent"))


def test_manager_close_all():
    mgr = SessionManager("default")
    mgr.create("s1")
    mgr.create("s2")
    _run(mgr.close_all())
    sessions = mgr.list()
    assert len(sessions) == 1
    assert sessions[0].session_id == "default"


def test_manager_sessions_isolated():
    mgr = SessionManager("default")
    s1 = mgr.create("s1")
    s2 = mgr.create("s2")
    s1.env["X"] = "from-s1"
    s1.cwd = "/s1"
    assert "X" not in s2.env
    assert s2.cwd == "/"


def test_manager_lock_for():
    mgr = SessionManager("default")
    lock = mgr.lock_for("default")
    assert lock is not None

    mgr.create("s1")
    lock2 = mgr.lock_for("s1")
    assert lock2 is not lock


def test_manager_create_with_mount_grants():
    mgr = SessionManager("default")
    grants = {"/s3": MountMode.READ, "/slack": MountMode.WRITE}
    s = mgr.create("agent", mount_grants=grants)
    assert s.mount_grants == grants


def test_manager_create_default_unrestricted():
    mgr = SessionManager("default")
    s = mgr.create("worker")
    assert s.mount_grants is None
