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
import binascii
import json
import logging
import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx

from mirage.server.paths import mirage_home
from mirage.types import JsonValue

LOGIN_FILE = "login.json"
LOGIN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
REFRESH_MARGIN_SECONDS = 60

logger = logging.getLogger(__name__)


class LoginError(RuntimeError):
    """The login cannot give a token: it is too old, or the issuer
    refused to refresh it."""


@dataclass
class Login:
    """What ``mirage login`` keeps, for the one server it logged in to.

    Args:
        url (str): the server the token is for; it goes nowhere else.
        access_token (str): the bearer token.
        logged_in_at (float): when the user signed in; the login ends
            30 days later, however often it was refreshed.
        refresh_token (str | None): swaps for a new access token; None
            for a pasted token.
        expires_at (float | None): when the access token ends, if known.
        client_id (str | None): the OAuth client that signed in.
        token_endpoint (str | None): where a refresh goes.
    """

    url: str
    access_token: str
    logged_in_at: float
    refresh_token: str | None = None
    expires_at: float | None = None
    client_id: str | None = None
    token_endpoint: str | None = None


def renew_by(login: Login) -> float:
    """When the user has to log in again.

    Args:
        login (Login): the login.

    Returns:
        float: 30 days after sign-in, or the pasted token's end if
            sooner.
    """
    ends = login.logged_in_at + LOGIN_MAX_AGE_SECONDS
    if login.refresh_token is None and login.expires_at is not None:
        return min(ends, login.expires_at)
    return ends


def login_path() -> Path:
    return mirage_home() / LOGIN_FILE


def read_login(path: Path | None = None) -> Login | None:
    """Read the stored login.

    Args:
        path (Path | None): the login file; defaults to ``login_path()``.

    Returns:
        Login | None: the login, or None when there is none.
    """
    use = path if path is not None else login_path()
    if not use.exists():
        return None
    return Login(**json.loads(use.read_text()))


def write_login(login: Login, path: Path | None = None) -> None:
    """Store a login, readable by this user only.

    Args:
        login (Login): the login.
        path (Path | None): the login file; defaults to ``login_path()``.
    """
    use = path if path is not None else login_path()
    use.parent.mkdir(parents=True, exist_ok=True)
    staged = use.with_name(f".{use.name}.{os.getpid()}")
    fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(asdict(login), f, indent=2)
    os.replace(staged, use)


def remove_login(path: Path | None = None) -> Login | None:
    """Forget the stored login.

    Args:
        path (Path | None): the login file; defaults to ``login_path()``.

    Returns:
        Login | None: the login removed, or None when there was none.
    """
    use = path if path is not None else login_path()
    login = read_login(use)
    use.unlink(missing_ok=True)
    return login


def token_claims(token: str) -> dict[str, JsonValue]:
    """Read a JWT's claims without checking them, to show and to time.

    Args:
        token (str): the token.

    Returns:
        dict[str, JsonValue]: its claims; empty when it is not a JWT.
    """
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    try:
        payload = base64.urlsafe_b64decode(
            parts[1] + "=" * (-len(parts[1]) % 4)
        )
        claims = json.loads(payload)
    except (binascii.Error, ValueError):
        return {}
    return claims if isinstance(claims, dict) else {}


def json_body(reply: httpx.Response) -> dict[str, JsonValue]:
    """An OAuth endpoint's JSON object, or empty when it sent none.

    Args:
        reply (httpx.Response): the endpoint's reply.

    Returns:
        dict[str, JsonValue]: the object.
    """
    try:
        body = reply.json()
    except ValueError:
        logger.debug(
            "%s answered %d without JSON", reply.url, reply.status_code
        )
        return {}
    return body if isinstance(body, dict) else {}


def ends_at(body: dict[str, JsonValue], now: float) -> float | None:
    """When a token endpoint's access token ends.

    Args:
        body (dict[str, JsonValue]): the endpoint's answer.
        now (float): when it was asked.

    Returns:
        float | None: the end, or None when it gave no ``expires_in``.
    """
    expires_in = body.get("expires_in")
    if isinstance(expires_in, (int, float)) and expires_in > 0:
        return now + expires_in
    return None


def fresh_token(login: Login, path: Path | None = None) -> str:
    """The login's access token, refreshed first when it is about to end.

    Args:
        login (Login): the login; updated in place on a refresh.
        path (Path | None): the login file a refresh is stored in;
            defaults to ``login_path()``.

    Returns:
        str: a token to send.

    Raises:
        LoginError: the login is over 30 days old, its token ended with
            nothing to refresh it, or the issuer refused the refresh.
    """
    now = time.time()
    again = f"run `mirage login` to log in to {login.url} again"
    if now >= login.logged_in_at + LOGIN_MAX_AGE_SECONDS:
        raise LoginError(f"the login is 30 days old; {again}")
    if login.expires_at is None or now < (
        login.expires_at - REFRESH_MARGIN_SECONDS
    ):
        return login.access_token
    if (
        login.refresh_token is None
        or login.token_endpoint is None
        or login.client_id is None
    ):
        raise LoginError(f"the token has expired; {again}")
    try:
        reply = httpx.post(
            login.token_endpoint,
            data={
                "grant_type": "refresh_token",
                "refresh_token": login.refresh_token,
                "client_id": login.client_id,
            },
            timeout=30,
        )
    except httpx.RequestError as e:
        raise LoginError(f"could not reach the issuer: {e}") from e
    body = json_body(reply)
    if reply.status_code != 200 or "access_token" not in body:
        raise LoginError(
            f"the issuer refused to refresh the login "
            f"({body.get('error', reply.status_code)}); {again}"
        )
    login.access_token = str(body["access_token"])
    login.refresh_token = str(body.get("refresh_token") or login.refresh_token)
    login.expires_at = ends_at(body, now)
    write_login(login, path)
    return login.access_token
