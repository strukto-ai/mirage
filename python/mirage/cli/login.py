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
import html
import secrets
import threading
import time
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import typer

from mirage.cli.credentials import (
    Login,
    LoginError,
    ends_at,
    json_body,
    read_login,
    remove_login,
    renew_by,
    token_claims,
    write_login,
)
from mirage.cli.output import emit, fail
from mirage.cli.settings import is_local_url, load_daemon_settings
from mirage.server.auth.config import (
    AUTHORIZATION_SERVER_PATH,
    PROTECTED_RESOURCE_PATH,
)
from mirage.types import JsonValue

CALLBACK_PATH = "/callback"
CALLBACK_TIMEOUT_SECONDS = 300
SCOPE = "profile email offline_access"


def no_login(url: str) -> str:
    return (
        f"{url} publishes no login: a local daemon needs none, and a "
        "server with a shared token takes `mirage login --token`"
    )


def metadata_url(issuer: str) -> str:
    """Where an issuer publishes its endpoints (RFC 8414).

    Args:
        issuer (str): the issuer.

    Returns:
        str: its authorization server metadata URL.
    """
    parts = urlsplit(issuer)
    return (
        f"{parts.scheme}://{parts.netloc}{AUTHORIZATION_SERVER_PATH}"
        f"{parts.path.rstrip('/')}"
    )


def _get_json(url: str) -> dict[str, JsonValue]:
    try:
        reply = httpx.get(url, timeout=30)
    except httpx.RequestError as e:
        raise LoginError(f"could not reach {url}: {e}") from e
    if reply.status_code != 200:
        raise LoginError(f"{url} answered {reply.status_code}")
    return json_body(reply)


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


class QuietHandler(BaseHTTPRequestHandler):
    """A request handler that writes no access log, so the code the
    browser brings back never lands on the terminal."""

    def log_message(self, format: str, *args: Any) -> None:
        return None


@dataclass
class Callback:
    """A one-time listener on 127.0.0.1 that the browser comes back to.

    Args:
        redirect (str): its URL, the OAuth redirect.
        answer (dict[str, str]): the query the browser came back with.
        done (threading.Event): set once the browser came back.
        server (ThreadingHTTPServer): the listener.
    """

    redirect: str
    answer: dict[str, str]
    done: threading.Event
    server: ThreadingHTTPServer

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def listen(state: str) -> Callback:
    """Start the listener the browser comes back to.

    Args:
        state (str): the state a callback must carry; any other is
            turned away.

    Returns:
        Callback: the running listener.
    """
    answer: dict[str, str] = {}
    done = threading.Event()

    class Handler(QuietHandler):
        def do_GET(self) -> None:
            parts = urlsplit(self.path)
            query = {k: v[0] for k, v in parse_qs(parts.query).items()}
            if parts.path != CALLBACK_PATH or query.get("state") != state:
                self.send_error(404)
                return
            answer.update(query)
            done.set()
            text = (
                "Logged in to Mirage. You can close this tab."
                if "code" in query
                else f"Login failed: {query.get('error', 'no code')}."
            )
            body = f"<!doctype html><p>{html.escape(text)}</p>".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return Callback(
        redirect=f"http://127.0.0.1:{server.server_port}{CALLBACK_PATH}",
        answer=answer,
        done=done,
        server=server,
    )


def open_browser(url: str) -> None:
    """Open a URL in the browser: ``$BROWSER`` when set, else the
    system's. The printed URL is the way in when none opens.

    Args:
        url (str): the URL.
    """
    webbrowser.open(url)


def browser_login(url: str) -> Login | None:
    """Log in through the server's issuer in the browser.

    The server names its issuer and OAuth client; the browser signs in
    there (or is already signed in) and comes back to a one-time
    listener on 127.0.0.1 with a code, which is swapped for the tokens
    with PKCE, so no secret is kept on this machine.

    Args:
        url (str): the server.

    Returns:
        Login | None: the login, or None when the server publishes none.

    Raises:
        LoginError: the server, the issuer or the browser refused, or
            no answer came back in time.
    """
    try:
        found = httpx.get(url + PROTECTED_RESOURCE_PATH, timeout=30)
    except httpx.RequestError as e:
        if is_local_url(url):
            return None
        raise LoginError(f"could not reach {url}: {e}") from e
    if found.status_code == 404:
        return None
    resource = json_body(found)
    servers = resource.get("authorization_servers")
    client_id = resource.get("client_id")
    if not isinstance(servers, list) or not servers or not client_id:
        raise LoginError(f"{url} published no issuer to log in through")
    issuer = str(servers[0])
    meta = _get_json(metadata_url(issuer))
    if meta.get("issuer") != issuer:
        raise LoginError(f"{issuer} published another issuer's endpoints")
    verifier = secrets.token_urlsafe(48)
    state = secrets.token_urlsafe(16)
    callback = listen(state)
    try:
        authorize = httpx.URL(
            str(meta["authorization_endpoint"])
        ).copy_merge_params(
            {
                "response_type": "code",
                "client_id": str(client_id),
                "redirect_uri": callback.redirect,
                "scope": SCOPE,
                "state": state,
                "code_challenge": _challenge(verifier),
                "code_challenge_method": "S256",
            }
        )
        typer.echo(
            f"Log in to {url} in your browser. If it does not open, "
            f"go to:\n\n  {authorize}\n",
            err=True,
        )
        open_browser(str(authorize))
        if not callback.done.wait(CALLBACK_TIMEOUT_SECONDS):
            raise LoginError("the browser did not come back in time")
    finally:
        callback.close()
    answer = callback.answer
    if "code" not in answer:
        raise LoginError(
            f"the issuer refused the login: {answer.get('error', 'no code')}"
        )
    token_endpoint = str(meta["token_endpoint"])
    signed_in = time.time()
    try:
        reply = httpx.post(
            token_endpoint,
            data={
                "grant_type": "authorization_code",
                "code": answer["code"],
                "redirect_uri": callback.redirect,
                "client_id": str(client_id),
                "code_verifier": verifier,
            },
            timeout=30,
        )
    except httpx.RequestError as e:
        raise LoginError(f"could not reach the issuer: {e}") from e
    body = json_body(reply)
    if reply.status_code != 200 or "access_token" not in body:
        raise LoginError(
            f"the issuer refused the code: "
            f"{body.get('error', reply.status_code)}"
        )
    refresh = body.get("refresh_token")
    return Login(
        url=url,
        access_token=str(body["access_token"]),
        logged_in_at=signed_in,
        refresh_token=str(refresh) if refresh else None,
        expires_at=ends_at(body, signed_in),
        client_id=str(client_id),
        token_endpoint=token_endpoint,
    )


def token_login(url: str, token: str) -> Login:
    """Keep a pasted token, once the server takes it.

    Args:
        url (str): the server.
        token (str): the token.

    Returns:
        Login: the login.

    Raises:
        LoginError: the server is out of reach or refused the token.
    """
    try:
        reply = httpx.get(
            f"{url}/v1/workspaces",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
    except httpx.RequestError as e:
        raise LoginError(f"could not reach {url}: {e}") from e
    if reply.status_code == 401:
        raise LoginError(f"{url} refused the token")
    exp = token_claims(token).get("exp")
    return Login(
        url=url,
        access_token=token,
        logged_in_at=time.time(),
        expires_at=float(exp) if isinstance(exp, (int, float)) else None,
    )


def login_cmd(
    token: str | None = typer.Option(
        None, "--token", help="Keep this token instead of using the browser."
    ),
) -> None:
    """Log in to the server the CLI points at.

    Opens the browser on the server's sign-in, or keeps ``--token``.
    Every command then sends the login's token to that server, and
    to no other; the login lasts 30 days.
    """
    url = load_daemon_settings().url.rstrip("/")
    login = token_login(url, token) if token else browser_login(url)
    if login is None:
        typer.echo(no_login(url))
        return
    write_login(login)
    account = token_claims(login.access_token).get("sub")
    typer.echo(f"Logged in to {url}" + (f" as {account}." if account else "."))


def logout_cmd() -> None:
    """Forget the stored login."""
    login = remove_login()
    typer.echo(f"Logged out of {login.url}." if login else "Not logged in.")


def whoami_cmd() -> None:
    """Print who the login is for, and when to log in again."""
    url = load_daemon_settings().url.rstrip("/")
    login = read_login()
    if login is None or login.url != url:
        fail(f"not logged in to {url}")
    account = token_claims(login.access_token).get("sub")
    renew = datetime.fromtimestamp(renew_by(login), timezone.utc)
    emit(
        {
            "account": account,
            "url": url,
            "renew_by": renew.strftime("%Y-%m-%d"),
        },
        human=lambda row: "\n".join(f"{k}: {v}" for k, v in row.items()),
    )
