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

import re
from contextlib import contextmanager

from typer.testing import CliRunner

from mirage.cli import session as session_cli

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


class _FakeResponse:
    status_code = 201
    content = b'{"session_id": "agent", "cwd": "/"}'

    def json(self) -> dict:
        return {"session_id": "agent", "cwd": "/"}


class _FakeClient:

    def __init__(self) -> None:
        self.last_body: dict | None = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def ensure_running(self, allow_spawn: bool = False) -> None:
        return None

    def request(self, method: str, path: str, json: dict | None = None):
        self.last_body = json
        return _FakeResponse()


@contextmanager
def _patched_client(fake: _FakeClient):
    real = session_cli.make_client
    session_cli.make_client = lambda: fake
    try:
        yield fake
    finally:
        session_cli.make_client = real


def test_session_create_passes_mount_flags():
    fake = _FakeClient()
    with _patched_client(fake):
        result = CliRunner().invoke(
            session_cli.app,
            [
                "create", "demo", "--id", "agent", "-m", "/s3", "--mount",
                "/slack"
            ],
        )
    assert result.exit_code == 0, result.output
    assert fake.last_body == {
        "session_id": "agent",
        "mounts": {
            "/s3": "exec",
            "/slack": "exec"
        },
    }


def test_session_create_parses_role_suffix():
    fake = _FakeClient()
    with _patched_client(fake):
        result = CliRunner().invoke(
            session_cli.app,
            [
                "create", "demo", "--id", "agent", "-m", "/data:read", "-m",
                "/scratch:write", "-m", "/tools"
            ],
        )
    assert result.exit_code == 0, result.output
    assert fake.last_body == {
        "session_id": "agent",
        "mounts": {
            "/data": "read",
            "/scratch": "write",
            "/tools": "exec"
        },
    }


def test_session_create_parses_alias_role_suffix():
    fake = _FakeClient()
    with _patched_client(fake):
        result = CliRunner().invoke(
            session_cli.app,
            [
                "create", "demo", "-m", "/data:r", "-m", "/scratch:rw", "-m",
                "/bin:rwx"
            ],
        )
    assert result.exit_code == 0, result.output
    assert fake.last_body == {
        "mounts": {
            "/data": "r",
            "/scratch": "rw",
            "/bin": "rwx"
        },
    }


def test_session_create_no_mount_flag_omits_field():
    fake = _FakeClient()
    with _patched_client(fake):
        result = CliRunner().invoke(
            session_cli.app,
            ["create", "demo", "--id", "agent"],
        )
    assert result.exit_code == 0, result.output
    assert fake.last_body == {"session_id": "agent"}


def test_session_create_without_id_or_mount_sends_empty_body():
    fake = _FakeClient()
    with _patched_client(fake):
        result = CliRunner().invoke(session_cli.app, ["create", "demo"])
    assert result.exit_code == 0, result.output
    assert fake.last_body == {}


def test_session_create_help_lists_mount_flag():
    result = CliRunner().invoke(session_cli.app, ["create", "--help"])
    assert result.exit_code == 0
    plain = _ANSI_RE.sub("", result.output)
    assert "--mount" in plain
