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

import base64
import hashlib
import json
import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import pytest
from typer.testing import CliRunner

from mirage.cli import login as login_module
from mirage.cli.credentials import LoginError, read_login, write_login
from mirage.cli.login import browser_login, metadata_url, token_login
from mirage.cli.main import app
from mirage.types import JsonValue

CLIENT_ID = "client_cli"


def _jwt(claims: dict) -> str:
    def part(value: dict) -> str:
        raw = json.dumps(value).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{part({'alg': 'RS256'})}.{part(claims)}.sig"


class FakeClerk:
    """A Mirage server's login metadata and a Clerk-shaped issuer, on
    one port: the authorize step acts as an already signed-in user.

    Args:
        publishes (bool): whether the server publishes a login.
        deny (bool): whether the user turns the login down.
        issuer (str | None): the issuer its metadata names; None names
            itself.
    """

    def __init__(
        self,
        publishes: bool = True,
        deny: bool = False,
        issuer: str | None = None,
    ) -> None:
        self.publishes = publishes
        self.deny = deny
        self.named = issuer
        self.codes: dict[str, dict[str, str]] = {}
        self.url = ""

    @contextmanager
    def serving(self) -> Iterator["FakeClerk"]:
        clerk = self

        class Handler(BaseHTTPRequestHandler):
            def reply(
                self, status: int, body: JsonValue, **headers: str
            ) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                parts = urlsplit(self.path)
                query = {k: v[0] for k, v in parse_qs(parts.query).items()}
                if parts.path == "/.well-known/oauth-protected-resource":
                    if not clerk.publishes:
                        self.reply(404, {"detail": "no login"})
                        return
                    self.reply(
                        200,
                        {
                            "resource": clerk.url,
                            "authorization_servers": [clerk.url],
                            "client_id": CLIENT_ID,
                        },
                    )
                elif parts.path == "/.well-known/oauth-authorization-server":
                    self.reply(
                        200,
                        {
                            "issuer": clerk.named or clerk.url,
                            "authorization_endpoint": f"{clerk.url}/oauth/authorize",
                            "token_endpoint": f"{clerk.url}/oauth/token",
                        },
                    )
                elif parts.path == "/oauth/authorize":
                    answer = {"state": query["state"]}
                    if clerk.deny:
                        answer["error"] = "access_denied"
                    else:
                        code = f"code{len(clerk.codes)}"
                        clerk.codes[code] = query
                        answer["code"] = code
                    location = f"{query['redirect_uri']}?{urlencode(answer)}"
                    self.reply(302, {}, Location=location)
                elif parts.path == "/v1/workspaces":
                    sent = self.headers.get("Authorization")
                    status = {"Bearer good": 200, "Bearer boom": 500}
                    self.reply(status.get(sent, 401), [])
                else:
                    self.reply(404, {})

            def do_POST(self) -> None:
                size = int(self.headers.get("Content-Length", "0"))
                form = {
                    k: v[0]
                    for k, v in parse_qs(
                        self.rfile.read(size).decode()
                    ).items()
                }
                asked = clerk.codes.pop(form.get("code", ""), None)
                digest = hashlib.sha256(
                    form.get("code_verifier", "").encode()
                ).digest()
                proof = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
                if (
                    asked is None
                    or form.get("grant_type") != "authorization_code"
                    or form.get("client_id") != asked["client_id"]
                    or form.get("redirect_uri") != asked["redirect_uri"]
                    or asked["code_challenge_method"] != "S256"
                    or proof != asked["code_challenge"]
                ):
                    self.reply(400, {"error": "invalid_grant"})
                    return
                self.reply(
                    200,
                    {
                        "access_token": _jwt({"sub": "user_alice"}),
                        "refresh_token": "r1",
                        "expires_in": 86400,
                        "token_type": "Bearer",
                    },
                )

            def log_message(self, format: str, *args: Any) -> None:
                return None

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{server.server_port}"
        try:
            yield self
        finally:
            server.shutdown()
            server.server_close()


@pytest.fixture
def browser(monkeypatch):
    """A browser where the user is already signed in: it follows the
    issuer's redirect back to the CLI."""
    opened: list[str] = []

    def visit(url: str) -> bool:
        opened.append(url)
        httpx.get(url, follow_redirects=True, timeout=10)
        return True

    monkeypatch.setattr(login_module.webbrowser, "open", visit)
    return opened


@pytest.fixture
def clerk() -> Iterator[FakeClerk]:
    with FakeClerk().serving() as fake:
        yield fake


def test_browser_login_signs_in_with_pkce_and_keeps_the_tokens(clerk, browser):
    login = browser_login(clerk.url)
    assert login is not None
    assert login.url == clerk.url
    assert login.refresh_token == "r1"
    assert login.client_id == CLIENT_ID
    assert login.token_endpoint == f"{clerk.url}/oauth/token"
    assert login.expires_at - login.logged_in_at == pytest.approx(86400)
    sent = dict(parse_qs(urlsplit(browser[0]).query))
    assert sent["scope"] == ["profile email offline_access"]
    assert sent["redirect_uri"][0].startswith("http://127.0.0.1:")


def test_a_callback_with_another_state_is_turned_away(clerk, monkeypatch):
    forged: list[int] = []

    def visit(url: str) -> bool:
        redirect = parse_qs(urlsplit(url).query)["redirect_uri"][0]
        forged.append(
            httpx.get(f"{redirect}?code=forged&state=other").status_code
        )
        httpx.get(url, follow_redirects=True, timeout=10)
        return True

    monkeypatch.setattr(login_module.webbrowser, "open", visit)
    login = browser_login(clerk.url)
    assert forged == [404]
    assert login is not None
    assert login.refresh_token == "r1"


def test_a_server_that_publishes_no_login_needs_none(browser):
    with FakeClerk(publishes=False).serving() as fake:
        assert browser_login(fake.url) is None
    assert browser == []


def test_a_local_server_that_is_down_needs_no_login(browser):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    assert browser_login(f"http://127.0.0.1:{port}") is None


def test_a_turned_down_login_fails(browser):
    with FakeClerk(deny=True).serving() as fake:
        with pytest.raises(LoginError, match="access_denied"):
            browser_login(fake.url)


def test_metadata_naming_another_issuer_is_refused(browser):
    with FakeClerk(issuer="https://elsewhere.test").serving() as fake:
        with pytest.raises(LoginError, match="another issuer"):
            browser_login(fake.url)
    assert browser == []


def test_metadata_url_goes_before_the_issuer_path():
    assert (
        metadata_url("https://clerk.example.com")
        == "https://clerk.example.com/.well-known/oauth-authorization-server"
    )
    assert (
        metadata_url("https://auth.example.com/tenant/")
        == "https://auth.example.com/.well-known/oauth-authorization-server/tenant"
    )


def test_a_pasted_token_is_kept_once_the_server_takes_it(clerk):
    login = token_login(clerk.url, "good")
    assert login.access_token == "good"
    assert login.refresh_token is None
    with pytest.raises(LoginError, match="refused the token"):
        token_login(clerk.url, "bad")
    with pytest.raises(LoginError, match="answered 500"):
        token_login(clerk.url, "boom")


def test_login_reads_a_dash_token_from_stdin(clerk, tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.setenv("MIRAGE_DAEMON_URL", clerk.url)
    done = CliRunner().invoke(app, ["login", "--token", "-"], input="good\n")
    assert done.exit_code == 0, done.output
    assert read_login().access_token == "good"
    empty = CliRunner().invoke(app, ["login", "--token", "-"], input="")
    assert empty.exit_code == 1
    assert "no token on stdin" in empty.output


def test_login_whoami_logout(clerk, browser, tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.setenv("MIRAGE_DAEMON_URL", clerk.url)
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    runner = CliRunner()
    done = runner.invoke(app, ["login"])
    assert done.exit_code == 0, done.output
    assert f"Logged in to {clerk.url} as user_alice." in done.output
    assert read_login().refresh_token == "r1"
    who = runner.invoke(app, ["whoami"])
    assert who.exit_code == 0
    assert json.loads(who.stdout)["account"] == "user_alice"
    out = runner.invoke(app, ["logout"])
    assert out.stdout == f"Logged out of {clerk.url}.\n"
    assert read_login() is None
    assert runner.invoke(app, ["whoami"]).exit_code == 1


def test_whoami_ignores_a_login_for_another_server(
    clerk, tmp_path, monkeypatch
):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.setenv("MIRAGE_DAEMON_URL", clerk.url)
    login = token_login(clerk.url, "good")
    login.url = "https://elsewhere.test"
    write_login(login)
    who = CliRunner().invoke(app, ["whoami"])
    assert who.exit_code == 1
    assert f"not logged in to {clerk.url}" in who.output


def test_login_to_a_server_without_one_says_so(browser, tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    with FakeClerk(publishes=False).serving() as fake:
        monkeypatch.setenv("MIRAGE_DAEMON_URL", fake.url)
        done = CliRunner().invoke(app, ["login"])
    assert done.exit_code == 0
    assert "publishes no login" in done.output
    assert read_login() is None
