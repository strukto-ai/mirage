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
import json
import stat
import time

import httpx
import pytest

from mirage.cli import credentials
from mirage.cli.credentials import (
    LOGIN_MAX_AGE_SECONDS,
    Login,
    LoginError,
    fresh_token,
    read_login,
    remove_login,
    renew_by,
    token_claims,
    write_login,
)


def _jwt(claims: dict) -> str:
    def part(value: dict) -> str:
        raw = json.dumps(value).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{part({'alg': 'RS256'})}.{part(claims)}.sig"


def _login(**fields) -> Login:
    base = {
        "url": "https://mirage.example.com",
        "access_token": "old",
        "logged_in_at": time.time(),
        "refresh_token": "r1",
        "expires_at": time.time() + 3600,
        "client_id": "client_cli",
        "token_endpoint": "https://clerk.example.com/oauth/token",
    }
    return Login(**{**base, **fields})


def test_a_stored_login_reads_back_whole_and_only_its_user_reads_it(
    tmp_path,
):
    path = tmp_path / "login.json"
    login = _login()
    write_login(login, path)
    assert read_login(path) == login
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_remove_returns_the_login_once(tmp_path):
    path = tmp_path / "login.json"
    login = _login()
    write_login(login, path)
    assert remove_login(path) == login
    assert read_login(path) is None
    assert remove_login(path) is None


def test_token_claims_reads_a_jwt_and_nothing_else():
    assert token_claims(_jwt({"sub": "user_alice"}))["sub"] == "user_alice"
    assert token_claims("opaque-token") == {}
    assert token_claims("a.!!!.c") == {}


def test_a_live_token_goes_out_as_it_is(tmp_path):
    assert fresh_token(_login(), tmp_path / "login.json") == "old"


def test_a_login_ends_30_days_after_sign_in_however_often_refreshed(
    tmp_path,
):
    old = _login(logged_in_at=time.time() - LOGIN_MAX_AGE_SECONDS - 1)
    with pytest.raises(LoginError, match="30 days old"):
        fresh_token(old, tmp_path / "login.json")


def test_an_ended_token_with_nothing_to_refresh_asks_to_log_in(tmp_path):
    pasted = _login(refresh_token=None, expires_at=time.time() - 1)
    with pytest.raises(LoginError, match="expired; run `mirage login`"):
        fresh_token(pasted, tmp_path / "login.json")


def test_an_ending_token_is_refreshed_and_stored(tmp_path, monkeypatch):
    sent = []

    def post(url, data, timeout):
        sent.append((url, data))
        return httpx.Response(
            200,
            json={"access_token": "new", "expires_in": 86400},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(credentials.httpx, "post", post)
    path = tmp_path / "login.json"
    login = _login(expires_at=time.time() + 10)
    assert fresh_token(login, path) == "new"
    assert sent == [
        (
            "https://clerk.example.com/oauth/token",
            {
                "grant_type": "refresh_token",
                "refresh_token": "r1",
                "client_id": "client_cli",
            },
        )
    ]
    stored = read_login(path)
    assert stored.access_token == "new"
    assert stored.refresh_token == "r1"
    assert stored.expires_at > time.time() + 86000


def test_a_refused_refresh_asks_to_log_in(tmp_path, monkeypatch):
    def post(url, data, timeout):
        return httpx.Response(
            400,
            json={"error": "invalid_grant"},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(credentials.httpx, "post", post)
    login = _login(expires_at=time.time() - 1)
    with pytest.raises(LoginError, match="invalid_grant"):
        fresh_token(login, tmp_path / "login.json")


def test_a_pasted_token_renews_by_its_own_end():
    ends = time.time() + 3600
    assert renew_by(_login(refresh_token=None, expires_at=ends)) == ends
    login = _login()
    assert renew_by(login) == login.logged_in_at + LOGIN_MAX_AGE_SECONDS
