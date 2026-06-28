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
import sys

import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.commands.builtin.general.curl import curl
from mirage.resource.base import BaseResource

curl_mod = sys.modules["mirage.commands.builtin.general.curl"]
wget_mod = sys.modules["mirage.commands.builtin.general.wget"]


@pytest.mark.network
class TestCurl:

    def test_curl_raw_returns_html(self):
        # Use example.com (rock-solid IANA reserved host) instead of
        # httpbin.org which is flaky (502s) in CI.
        result, _ = asyncio.run(curl(None, None, "https://example.com"))
        body = result.decode() if isinstance(result, bytes) else result
        assert "<html" in body.lower() or "<h1" in body.lower()

    def test_curl_jina_returns_markdown(self):
        result, _ = asyncio.run(
            curl(None, None, "https://example.com", jina=True))
        body = result.decode() if isinstance(result, bytes) else result
        assert "<html" not in body.lower()
        assert "Example Domain" in body


@pytest.fixture
def mock_http(monkeypatch):
    payload = b"hello body"

    def _fake_request(url,
                      method="GET",
                      headers=None,
                      data=None,
                      timeout=30,
                      jina=False):
        return payload

    def _fake_get(url, headers=None, timeout=30, jina=False):
        return payload

    monkeypatch.setattr(curl_mod, "_http_request", _fake_request)
    monkeypatch.setattr(wget_mod, "_http_get", _fake_get)
    return payload


@pytest.fixture
def multi_mount_ws():
    ws = Workspace(
        {
            "/ram": (RAMResource(), MountMode.WRITE),
            "/readonly": (RAMResource(), MountMode.READ),
            "/nowrite": (BaseResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    ws.get_session("default").cwd = "/"
    return ws


@pytest.mark.asyncio
async def test_curl_o_persists_to_writable_mount(multi_mount_ws, mock_http):
    io = await multi_mount_ws.execute(
        "curl -s https://x.test/file -o /ram/foo.bin")
    assert io.exit_code == 0
    data = await multi_mount_ws.ops.read("/ram/foo.bin")
    assert data == mock_http


@pytest.mark.asyncio
async def test_curl_o_readonly_mount_fails(multi_mount_ws, mock_http):
    io = await multi_mount_ws.execute(
        "curl -s https://x.test/file -o /readonly/foo.bin")
    assert io.exit_code == 1
    err = (io.stderr or b"").decode()
    assert "read-only" in err
    assert "/readonly/foo.bin" in err


@pytest.mark.asyncio
async def test_curl_o_missing_parent_dir_fails(multi_mount_ws, mock_http):
    # The virtual root catches any absolute path, so an unmounted target no
    # longer fails with "no mount"; it routes to the root and fails because
    # the parent directory does not exist there (no silent success).
    io = await multi_mount_ws.execute(
        "curl -s https://x.test/file -o /nope/foo.bin")
    assert io.exit_code == 1
    err = (io.stderr or b"").decode()
    assert "parent directory does not exist" in err
    assert "/nope" in err


@pytest.mark.asyncio
async def test_curl_o_resource_without_write_op_fails(multi_mount_ws,
                                                      mock_http):
    io = await multi_mount_ws.execute(
        "curl -s https://x.test/file -o /nowrite/foo.bin")
    assert io.exit_code == 1
    err = (io.stderr or b"").decode()
    assert "no op" in err or "write" in err
    assert "/nowrite/foo.bin" in err


@pytest.mark.asyncio
async def test_wget_O_persists_to_writable_mount(multi_mount_ws, mock_http):
    io = await multi_mount_ws.execute(
        "wget -q -O /ram/wget.bin https://x.test/file")
    assert io.exit_code == 0
    data = await multi_mount_ws.ops.read("/ram/wget.bin")
    assert data == mock_http


@pytest.mark.asyncio
async def test_wget_O_readonly_mount_fails(multi_mount_ws, mock_http):
    io = await multi_mount_ws.execute(
        "wget -q -O /readonly/wget.bin https://x.test/file")
    assert io.exit_code == 1
    err = (io.stderr or b"").decode()
    assert "read-only" in err


@pytest.fixture
def captured_headers(monkeypatch):
    import httpx
    captured: dict[str, dict[str, str]] = {}

    class _Resp:

        content = b""
        status_code = 200

        def raise_for_status(self):
            return None

    def _fake_request(self, method, url, headers=None, **_kw):
        captured["headers"] = dict(headers or {})
        return _Resp()

    monkeypatch.setattr(httpx.Client, "request", _fake_request)
    return captured


@pytest.mark.asyncio
async def test_curl_sends_default_user_agent(multi_mount_ws, captured_headers):
    io = await multi_mount_ws.execute("curl -s https://x.test/file")
    assert io.exit_code == 0
    assert captured_headers["headers"]["User-Agent"].startswith("Mozilla/5.0")


@pytest.mark.asyncio
async def test_curl_A_flag_overrides_user_agent(multi_mount_ws,
                                                captured_headers):
    io = await multi_mount_ws.execute(
        "curl -s -A my-agent/9 https://x.test/file")
    assert io.exit_code == 0
    assert captured_headers["headers"]["User-Agent"] == "my-agent/9"


@pytest.mark.asyncio
async def test_curl_H_user_agent_overrides_default(multi_mount_ws,
                                                   captured_headers):
    io = await multi_mount_ws.execute(
        "curl -s -H 'User-Agent: from-H/1' https://x.test/file")
    assert io.exit_code == 0
    assert captured_headers["headers"]["User-Agent"] == "from-H/1"
