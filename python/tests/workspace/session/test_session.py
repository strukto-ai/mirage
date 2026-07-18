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

from mirage.types import MountMode
from mirage.workspace.session import Session


def test_session_defaults():
    s = Session(session_id="test")
    assert s.session_id == "test"
    assert s.cwd == "/"
    assert s.env == {}
    assert s.functions == {}
    assert s.last_exit_code == 0
    assert s._stdin_buffer is None


def test_session_custom_cwd():
    s = Session(session_id="s1", cwd="/data")
    assert s.cwd == "/data"


def test_session_env():
    s = Session(session_id="s1", env={"A": "1", "B": "2"})
    assert s.env["A"] == "1"
    assert s.env["B"] == "2"


def test_session_env_mutation():
    s = Session(session_id="s1")
    s.env["X"] = "hello"
    assert s.env["X"] == "hello"
    del s.env["X"]
    assert "X" not in s.env


def test_session_functions():
    s = Session(session_id="s1")
    s.functions["myfunc"] = []
    assert "myfunc" in s.functions


def test_session_exit_code():
    s = Session(session_id="s1")
    s.last_exit_code = 42
    assert s.last_exit_code == 42


def test_session_stdin_buffer():
    s = Session(session_id="s1")
    s._stdin_buffer = b"hello\n"
    assert s._stdin_buffer == b"hello\n"
    s._stdin_buffer = None
    assert s._stdin_buffer is None


def test_session_to_dict():
    s = Session(session_id="s1", cwd="/data", env={"K": "V"})
    d = s.to_dict()
    assert d["session_id"] == "s1"
    assert d["cwd"] == "/data"
    assert d["env"] == {"K": "V"}
    assert "created_at" in d


def test_session_from_dict():
    d = {
        "session_id": "s2",
        "cwd": "/tmp",
        "env": {
            "A": "1"
        },
        "created_at": 123.0
    }
    s = Session.from_dict(d)
    assert s.session_id == "s2"
    assert s.cwd == "/tmp"
    assert s.env["A"] == "1"
    assert s.created_at == 123.0


def test_session_roundtrip():
    original = Session(session_id="rt", cwd="/x", env={"K": "V"})
    restored = Session.from_dict(original.to_dict())
    assert restored.session_id == original.session_id
    assert restored.cwd == original.cwd
    assert restored.env == original.env


def test_session_independent_envs():
    s1 = Session(session_id="a")
    s2 = Session(session_id="b")
    s1.env["X"] = "1"
    assert "X" not in s2.env


def test_session_mount_modes_default_none():
    s = Session(session_id="s")
    assert s.mount_modes is None


def test_session_mount_modes_set():
    grants = {"/s3": MountMode.READ, "/slack": MountMode.WRITE}
    s = Session(session_id="s", mount_modes=grants)
    assert s.mount_modes == grants


def test_fork_copies_every_field_including_mount_modes():
    original = Session(
        session_id="orig",
        cwd="/disk",
        env={"FOO": "bar"},
        functions={"f": object()},
        last_exit_code=7,
        shell_options={"errexit": True},
        readonly_vars={"HOME"},
        arrays={"ARGV": ["a", "b"]},
        mount_modes={
            "/s3": MountMode.READ,
            "/dev": MountMode.EXEC,
            "/": MountMode.EXEC,
        },
    )
    forked = original.fork()
    assert forked.session_id == "orig"
    assert forked.cwd == "/disk"
    assert forked.env == {"FOO": "bar"}
    assert forked.mount_modes == {
        "/s3": MountMode.READ,
        "/dev": MountMode.EXEC,
        "/": MountMode.EXEC,
    }
    assert forked.mount_modes is not original.mount_modes
    assert forked.shell_options == {"errexit": True}
    assert "HOME" in forked.readonly_vars
    assert forked.arrays == {"ARGV": ["a", "b"]}
    assert forked.last_exit_code == 7


def test_to_dict_round_trips_mount_modes():
    s = Session(session_id="s",
                mount_modes={
                    "/s3": MountMode.READ,
                    "/scratch": MountMode.WRITE,
                })
    data = s.to_dict()
    assert data["mount_modes"] == {"/s3": "read", "/scratch": "write"}
    restored = Session.from_dict(data)
    assert restored.mount_modes == {
        "/s3": MountMode.READ,
        "/scratch": MountMode.WRITE,
    }
    assert isinstance(next(iter(restored.mount_modes.values())), MountMode)


def test_to_dict_omits_grants_when_unrestricted():
    s = Session(session_id="s")
    data = s.to_dict()
    assert "mount_modes" not in data
    assert Session.from_dict(data).mount_modes is None


def test_fork_overrides_apply_without_mutating_original():
    original = Session(session_id="orig", cwd="/disk", env={"FOO": "bar"})
    forked = original.fork(cwd="/ram", env={"BAZ": "qux"})
    assert forked.cwd == "/ram"
    assert forked.env == {"BAZ": "qux"}
    assert original.cwd == "/disk"
    assert original.env == {"FOO": "bar"}


def test_fork_deep_copies_mutable_containers():
    original = Session(session_id="orig",
                       env={"FOO": "bar"},
                       arrays={"A": ["1"]})
    forked = original.fork()
    forked.env["NEW"] = "leaked?"
    forked.arrays["A"].append("2")
    assert "NEW" not in original.env
    assert original.arrays["A"] == ["1"]
