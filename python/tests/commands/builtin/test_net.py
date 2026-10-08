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

import datetime
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.builtin.general.curl import curl
from mirage.commands.builtin.utils.http import HttpResponse
from mirage.commands.config import CommandOpts
from mirage.vfs.base import BaseVFS

curl_mod = sys.modules["mirage.commands.builtin.general.curl"]
wget_mod = sys.modules["mirage.commands.builtin.general.wget"]


class _Page(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass

    def do_GET(self) -> None:
        body = b"<html><body><h1>Local Test Page</h1></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def http_url():
    with ThreadingHTTPServer(("127.0.0.1", 0), _Page) as server:
        thread = threading.Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_address[1]}/"
        finally:
            server.shutdown()
            thread.join()


class TestCurl:
    @pytest.mark.asyncio
    async def test_curl_raw_returns_html(self, http_url):
        result, io = await curl(None, None, [http_url], CommandOpts())
        assert io.exit_code == 0
        assert result == b"<html><body><h1>Local Test Page</h1></body></html>"


@pytest.fixture
def mock_http(monkeypatch):
    payload = b"hello body"

    async def _fake_request(
        url,
        method="GET",
        headers=None,
        data=None,
        timeout=30,
        follow_redirects=False,
        verify=True,
    ):
        return HttpResponse(status=200, reason="OK", body=payload, url=url)

    async def _fake_get(url, headers=None, timeout=30, follow_redirects=True):
        return HttpResponse(status=200, reason="OK", body=payload, url=url)

    monkeypatch.setattr(curl_mod, "http_request", _fake_request)
    monkeypatch.setattr(wget_mod, "http_get", _fake_get)
    return payload


@pytest.fixture
def multi_mount_ws():
    ws = Workspace(
        {
            "/ram": (RAMVFS(), MountMode.WRITE),
            "/readonly": (RAMVFS(), MountMode.READ),
            "/nowrite": (BaseVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    ws.get_session(ws.default_session_id).cwd = "/"
    return ws


@pytest.mark.asyncio
async def test_curl_o_persists_to_writable_mount(multi_mount_ws, mock_http):
    io = await multi_mount_ws.shell(
        "curl -s https://x.test/file -o /ram/foo.bin"
    )
    assert io.exit_code == 0
    data = await multi_mount_ws.vfs.read("/ram/foo.bin")
    assert data == mock_http


@pytest.mark.asyncio
async def test_curl_o_readonly_mount_fails(multi_mount_ws, mock_http):
    io = await multi_mount_ws.shell(
        "curl -sS https://x.test/file -o /readonly/foo.bin"
    )
    assert io.exit_code == 23
    err = (io.stderr or b"").decode()
    assert "Read-only file system" in err
    assert "/readonly/foo.bin" in err


@pytest.mark.asyncio
async def test_curl_o_missing_parent_dir_fails(multi_mount_ws, mock_http):
    # The virtual root catches any absolute path, so an unmounted target no
    # longer fails with "no mount"; it routes to the root and fails because
    # the parent directory does not exist there (no silent success).
    io = await multi_mount_ws.shell(
        "curl -sS https://x.test/file -o /nope/foo.bin"
    )
    assert io.exit_code == 23
    err = (io.stderr or b"").decode()
    assert "No such file or directory" in err
    assert "/nope/foo.bin" in err


@pytest.mark.asyncio
async def test_curl_o_vfs_without_write_op_fails(multi_mount_ws, mock_http):
    io = await multi_mount_ws.shell(
        "curl -sS https://x.test/file -o /nowrite/foo.bin"
    )
    assert io.exit_code == 23
    err = (io.stderr or b"").decode()
    assert "no op" in err or "write" in err
    assert "/nowrite/foo.bin" in err


@pytest.mark.asyncio
async def test_wget_O_persists_to_writable_mount(multi_mount_ws, mock_http):
    io = await multi_mount_ws.shell(
        "wget -q -O /ram/wget.bin https://x.test/file"
    )
    assert io.exit_code == 0
    data = await multi_mount_ws.vfs.read("/ram/wget.bin")
    assert data == mock_http


@pytest.mark.asyncio
async def test_wget_O_readonly_mount_fails(multi_mount_ws, mock_http):
    io = await multi_mount_ws.shell(
        "wget -O /readonly/wget.bin https://x.test/file"
    )
    assert io.exit_code == 1
    err = (io.stderr or b"").decode()
    assert "Read-only file system" in err


@pytest.fixture
def captured_headers(monkeypatch):
    import httpx

    captured: dict[str, dict[str, str]] = {}

    class _Headers:
        def multi_items(self) -> list[tuple[str, str]]:
            return []

    class _Request:
        def __init__(self, method: str) -> None:
            self.method = method

    class _Resp:
        content = b""
        status_code = 200
        reason_phrase = "OK"
        headers = _Headers()
        history: list = []

        def __init__(self, method: str, url: str) -> None:
            self.request = _Request(method)
            self.url = url

    async def _fake_request(self, method, url, headers=None, **_kw):
        captured["headers"] = dict(headers or {})
        return _Resp(method, url)

    monkeypatch.setattr(httpx.AsyncClient, "request", _fake_request)
    return captured


@pytest.mark.asyncio
async def test_curl_sends_default_user_agent(multi_mount_ws, captured_headers):
    io = await multi_mount_ws.shell("curl -s https://x.test/file")
    assert io.exit_code == 0
    assert captured_headers["headers"]["User-Agent"].startswith("Mozilla/5.0")


@pytest.mark.asyncio
async def test_curl_A_flag_overrides_user_agent(
    multi_mount_ws, captured_headers
):
    io = await multi_mount_ws.shell(
        "curl -s -A my-agent/9 https://x.test/file"
    )
    assert io.exit_code == 0
    assert captured_headers["headers"]["User-Agent"] == "my-agent/9"


@pytest.mark.asyncio
async def test_curl_H_user_agent_overrides_default(
    multi_mount_ws, captured_headers
):
    io = await multi_mount_ws.shell(
        "curl -s -H 'User-Agent: from-H/1' https://x.test/file"
    )
    assert io.exit_code == 0
    assert captured_headers["headers"]["User-Agent"] == "from-H/1"


class _Secure(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Length", "7")
        self.end_headers()
        self.wfile.write(b"secure\n")


@pytest.fixture
def self_signed_url(tmp_path):
    """An HTTPS server whose certificate is its own, so nothing trusts it."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    (tmp_path / "cert.pem").write_bytes(
        cert.public_bytes(serialization.Encoding.PEM)
    )
    (tmp_path / "key.pem").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(tmp_path / "cert.pem", tmp_path / "key.pem")
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Secure)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"https://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()
    server.server_close()


# curl verifies the server's certificate and -k skips the check, as curl
# 8.14.1 does. A refused certificate is a connect failure here (curl's own
# code for it is 60).
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flag,code,out",
    [
        ("", 7, b""),
        ("-k", 0, b"secure\n"),
        ("--insecure", 0, b"secure\n"),
    ],
)
async def test_curl_insecure_skips_certificate_verification(
    multi_mount_ws, self_signed_url, flag, code, out
):
    io = await multi_mount_ws.shell(f"curl {flag} -sS {self_signed_url}")
    assert (io.exit_code, await io.stdout_str()) == (code, out.decode())
