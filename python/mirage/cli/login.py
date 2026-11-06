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
import logging
import secrets
import sys
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

from mirage.cli.constants import HOSTED, HOSTED_URL, LOCAL
from mirage.cli.credentials import (
    Context,
    ContextError,
    Login,
    LoginError,
    check_name,
    chosen_name,
    context_names,
    current_name,
    ends_at,
    json_body,
    login_path,
    read_context,
    read_current,
    read_login,
    remove_context,
    remove_login,
    renew_by,
    token_claims,
    write_context,
    write_current,
    write_login,
)
from mirage.cli.output import emit, fail, format_table
from mirage.cli.settings import (
    current_workspace,
    default_local_url,
    header,
    is_local_url,
    load_daemon_settings,
    local_url,
)
from mirage.server.auth.config import (
    AUTHORIZATION_SERVER_PATH,
    PROTECTED_RESOURCE_PATH,
)
from mirage.server.daemon_config import read_daemon_table
from mirage.server.paths import mirage_home
from mirage.types import JsonValue

CALLBACK_PATH = "/callback"
CALLBACK_TIMEOUT_SECONDS = 300
SCOPE = "profile email offline_access"

context_app = typer.Typer(
    no_args_is_help=True,
    help="The servers the CLI talks to: list, switch, forget.",
)

logger = logging.getLogger(__name__)


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
        LoginError: the server is out of reach or did not take the
            token.
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
    if not reply.is_success:
        raise LoginError(f"{url} answered {reply.status_code}")
    exp = token_claims(token).get("exp")
    return Login(
        url=url,
        access_token=token,
        logged_in_at=time.time(),
        expires_at=float(exp) if isinstance(exp, (int, float)) else None,
    )


def context_name(url: str) -> str:
    """The context a login makes when given no ``--name``.

    Args:
        url (str): the server.

    Returns:
        str: ``strukto`` for the hosted console, ``local`` for this
            machine, else the server's host.
    """
    if url == HOSTED_URL:
        return HOSTED
    if is_local_url(url):
        return LOCAL
    return (urlsplit(url).hostname or "").lower()


def team_of(url: str, token: str) -> str | None:
    """The team a login acts for, as the server's ``/v1/me`` names it.

    Args:
        url (str): the server.
        token (str): the login's token.

    Returns:
        str | None: the team, or None when the server names none.
    """
    try:
        reply = httpx.get(
            f"{url}/v1/me",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
    except httpx.RequestError as e:
        logger.debug("%s/v1/me is out of reach: %s", url, e)
        return None
    team = json_body(reply).get("team_id") if reply.is_success else None
    return team if isinstance(team, str) and team else None


def save_context(name: str, url: str, login: Login | None) -> None:
    """Keep a context for ``url`` and make it current.

    It keeps its workspace while it points at the same server.
    ``local`` keeps no URL when ``url`` is the one it follows anyway.

    Args:
        name (str): the context.
        url (str): the server.
        login (Login | None): the login, when the server has one.
    """
    team = team_of(url, login.access_token) if login else None
    kept = read_context(name)
    stored = url
    if name == LOCAL and url == default_local_url(
        read_daemon_table(mirage_home())
    ):
        stored = ""
    write_context(
        name,
        Context(
            url=stored,
            team=team,
            workspace=kept.workspace
            if kept is not None and kept.url == stored
            else None,
        ),
    )
    write_current(name)


def login_cmd(
    url: str | None = typer.Argument(
        None, help="The server; the hosted console when left out."
    ),
    name: str | None = typer.Option(
        None,
        "--name",
        help="Name the context; by default strukto for the hosted "
        "console, local for this machine, else the server's host.",
    ),
    token: str | None = typer.Option(
        None,
        "--token",
        help="Keep this token instead of using the browser; - reads it "
        "from stdin.",
    ),
) -> None:
    """Log in to a server and make it the current context.

    Opens the browser on the server's sign-in, or keeps ``--token``
    (``-`` reads it from stdin, out of the shell's history). Every
    command in the context then sends the login's token to that
    server, and to no other; the login lasts 30 days.
    """
    if token == "-":
        token = sys.stdin.read().strip()
        if not token:
            fail("no token on stdin")
    target = (url or HOSTED_URL).rstrip("/")
    context = check_name(name or context_name(target))
    login = token_login(target, token) if token else browser_login(target)
    save_context(context, target, login)
    if login is None:
        typer.echo(no_login(target))
        return
    write_login(login, login_path(context))
    header("logged in", context)
    account = token_claims(login.access_token).get("sub")
    typer.echo(
        f"Logged in to {target}" + (f" as {account}." if account else ".")
    )


def logout_cmd() -> None:
    """Sign out of the current context; the context stays."""
    login = remove_login()
    typer.echo(f"Logged out of {login.url}." if login else "Not logged in.")


def whoami_cmd() -> None:
    """Print the current context: its server, team, user and
    workspace, and when to log in again."""
    url = load_daemon_settings().url.rstrip("/")
    name = current_name()
    context = read_context(name)
    login = read_login(login_path(name))
    if login is not None and login.url != url:
        login = None
    renew = (
        datetime.fromtimestamp(renew_by(login), timezone.utc).strftime(
            "%Y-%m-%d"
        )
        if login
        else None
    )
    emit(
        {
            "context": name,
            "url": url,
            "team": context.team if context else None,
            "user": token_claims(login.access_token).get("sub")
            if login
            else None,
            "workspace": current_workspace(),
            "renew_by": renew,
        },
        human=lambda row: "\n".join(
            f"{k}: {'-' if v is None else v}" for k, v in row.items()
        ),
    )


@context_app.command("list")
def list_cmd() -> None:
    """List the contexts; the current one is marked."""
    current = chosen_name()
    table = read_daemon_table(mirage_home())
    rows = []
    for name in context_names():
        entry = read_context(name) or Context()
        rows.append(
            {
                "name": name,
                "url": entry.url or local_url(table),
                "team": entry.team,
                "workspace": entry.workspace,
                "current": name == current,
            }
        )
    emit(
        rows,
        human=lambda items: format_table(
            ["", "NAME", "URL", "TEAM", "WORKSPACE"],
            [
                [
                    "*" if r["current"] else "",
                    r["name"],
                    r["url"],
                    r["team"] or "",
                    r["workspace"] or "",
                ]
                for r in items
            ],
        ),
    )


@context_app.command("use")
def use_cmd(name: str = typer.Argument(..., help="Context name.")) -> None:
    """Make a context the current one."""
    if read_context(name) is None:
        raise ContextError(f"no context {name!r}; run `mirage context list`")
    write_current(name)
    header("now current", name)
    emit({"current": name}, human=lambda d: f"Using context {name}.")


@context_app.command("delete")
def delete_cmd(
    name: str = typer.Argument(..., help="Context name."),
) -> None:
    """Forget a context and its login; ``local`` stays."""
    if name == LOCAL:
        raise ContextError("the local context cannot be deleted")
    if read_context(name) is None:
        raise ContextError(f"no context {name!r}; run `mirage context list`")
    if read_current() == name:
        write_current(LOCAL)
    remove_context(name)
    emit({"deleted": name}, human=lambda d: f"Deleted context {name}.")
