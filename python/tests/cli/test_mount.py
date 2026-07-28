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

import json
from contextlib import contextmanager

from typer.testing import CliRunner

from mirage.cli import mount as mount_cli


class _FakeResponse:

    def __init__(self, status_code: int, payload: dict | list) -> None:
        self.status_code = status_code
        self.content = json.dumps(payload).encode()
        self._payload = payload

    def json(self):
        return self._payload


class _FakeClient:

    def __init__(self, responses: dict[str, _FakeResponse]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, str, dict | None]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def ensure_running(self, allow_spawn: bool = False) -> None:
        return None

    def request(self, method: str, path: str, json: dict | None = None):
        self.calls.append((method, path, json))
        return self.responses.get(method, _FakeResponse(200, {"id": "x"}))


@contextmanager
def _patched_client(fake: _FakeClient):
    real = mount_cli.make_client
    mount_cli.make_client = lambda: fake
    try:
        yield fake
    finally:
        mount_cli.make_client = real


def test_mount_id_is_deterministic_and_collision_free():
    assert mount_cli.mount_id("/data") == mount_cli.mount_id("/data")
    assert mount_cli.mount_id("/data") != mount_cli.mount_id("/data-x")
    assert mount_cli.mount_id("/data/x") != mount_cli.mount_id("/data-x")
    assert mount_cli.mount_id("/").startswith("mnt-root-")


def test_add_posts_single_mount_config_with_fuse_target():
    spec = {"resource": "s3", "config": {"bucket": "b"}}
    fake = _FakeClient({
        "DELETE": _FakeResponse(404, {}),
        "POST": _FakeResponse(201, {"id": "x"}),
    })
    runner = CliRunner()
    with _patched_client(fake):
        result = runner.invoke(mount_cli.app,
                               ["add", "/data", "--fuse", "/workspace/data"],
                               env={mount_cli.SPEC_ENV: json.dumps(spec)})
    assert result.exit_code == 0, result.output
    posts = [call for call in fake.calls if call[0] == "POST"]
    assert len(posts) == 1
    body = posts[0][2]
    assert body["id"] == mount_cli.mount_id("/data")
    assert body["config"]["mounts"]["/data"] == {
        "resource": "s3",
        "config": {
            "bucket": "b"
        },
        "fuse": "/workspace/data",
    }
    # Idempotent replace: a stale same-prefix mount is deleted first.
    assert fake.calls[0][0] == "DELETE"


def test_add_without_spec_env_fails_loud():
    runner = CliRunner()
    with _patched_client(_FakeClient({})):
        result = runner.invoke(mount_cli.app,
                               ["add", "/data", "--fuse", "/w/data"],
                               env={mount_cli.SPEC_ENV: ""})
    assert result.exit_code != 0
    assert "MIRAGE_MOUNT_SPEC" in result.output


def test_remove_missing_mount_is_not_an_error():
    fake = _FakeClient({"DELETE": _FakeResponse(404, {})})
    runner = CliRunner()
    with _patched_client(fake):
        result = runner.invoke(mount_cli.app, ["remove", "/data"])
    assert result.exit_code == 0
    assert json.loads(result.output) == {"prefix": "/data", "removed": False}
