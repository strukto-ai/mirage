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
from typing import Any

import httpx
import pytest
import yaml
from typer.testing import CliRunner

from mirage.cli import policy as policy_cli

GUARD = "def pre_command(call):\n    return None\n"


class FakeClient:
    """The daemon's ``/v1/policies`` over a dict, recording each call."""

    def __init__(self) -> None:
        self.saved: dict[str, str] = {}
        self.calls: list[tuple[str, str, dict[str, str] | None]] = []

    def __enter__(self) -> "FakeClient":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def ensure_running(self, allow_spawn: bool = True) -> None:
        return None

    def request(
        self, method: str, path: str, json: dict[str, str] | None = None
    ) -> httpx.Response:
        self.calls.append((method, path, json))
        name = path.removeprefix("/v1/policies").lstrip("/")
        if method == "GET" and not name:
            items = [{"name": n} for n in sorted(self.saved)]
            return httpx.Response(200, json={"items": items})
        if method == "POST":
            assert json is not None
            if json["name"] in self.saved:
                return httpx.Response(409, json={"detail": "exists"})
            self.saved[json["name"]] = json["source"]
            return httpx.Response(201, json=json)
        if name not in self.saved:
            return httpx.Response(404, json={"detail": "no policy"})
        if method == "PUT":
            assert json is not None
            self.saved[name] = json["source"]
        if method == "DELETE":
            del self.saved[name]
            return httpx.Response(204)
        return httpx.Response(
            200, json={"name": name, "source": self.saved[name]}
        )


@pytest.fixture
def daemon(monkeypatch: pytest.MonkeyPatch) -> FakeClient:
    fake = FakeClient()
    monkeypatch.setattr(policy_cli, "make_client", lambda: fake)
    return fake


def run(*args: str) -> tuple[int, str]:
    result = CliRunner().invoke(policy_cli.app, list(args))
    return result.exit_code, result.output


def test_a_policy_is_created_from_a_file_and_read_back(daemon, tmp_path):
    path = tmp_path / "guard.py"
    path.write_text(GUARD)
    code, _ = run("create", "guard.py", "--source", f"@{path}")
    assert code == 0
    assert daemon.saved == {"guard.py": GUARD}
    code, out = run("get", "guard.py", "-o", "yaml")
    assert yaml.safe_load(out) == {"name": "guard.py", "source": GUARD}
    code, out = run("get", "guard.py", "-o", "json")
    assert json.loads(out) == {"name": "guard.py", "source": GUARD}


def test_list_update_and_delete_reach_the_routes(daemon):
    assert run("create", "a.py", "--source", "x = 1")[0] == 0
    code, out = run("list", "-o", "json")
    assert json.loads(out) == [{"name": "a.py"}]
    assert run("update", "a.py", "--source", "x = 2")[0] == 0
    assert daemon.saved == {"a.py": "x = 2"}
    assert run("delete", "a.py")[0] == 0
    assert daemon.saved == {}
    assert [c[:2] for c in daemon.calls] == [
        ("POST", "/v1/policies"),
        ("GET", "/v1/policies"),
        ("PUT", "/v1/policies/a.py"),
        ("DELETE", "/v1/policies/a.py"),
    ]


def test_a_refused_call_exits_2_with_the_daemons_reason(daemon):
    code, out = run("update", "nope.py", "--source", "x")
    assert code == 2
    assert "404" in out


def test_a_missing_source_file_exits_2(daemon, tmp_path):
    code, out = run("create", "a.py", "--source", f"@{tmp_path}/none.py")
    assert code == 2
    assert daemon.calls == []
