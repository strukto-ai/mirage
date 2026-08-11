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

import pytest

from mirage.commands.builtin.utils import http as http_mod
from mirage.commands.builtin.utils.http import (DEFAULT_USER_AGENT,
                                                HttpConnectError, HttpResponse,
                                                _endpoint, _http_request,
                                                _with_default_ua)


class _FakeResponse:

    def __init__(self, status: int, reason: str, content: bytes) -> None:
        self.status_code = status
        self.reason_phrase = reason
        self.content = content


class _FakeClient:

    def __init__(self, resp=None, exc=None, **kwargs) -> None:
        self.resp = resp
        self.exc = exc
        self.kwargs = kwargs
        self.calls: list[dict] = []

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> None:
        return None

    def request(self, method, url, headers=None, content=None, data=None):
        self.calls.append({
            "method": method,
            "url": url,
            "headers": headers,
            "content": content,
        })
        if self.exc is not None:
            raise self.exc
        return self.resp


class _FakeTransportError(Exception):
    pass


class _FakeHttpx:

    TransportError = _FakeTransportError

    def __init__(self, resp=None, exc=None) -> None:
        self.resp = resp
        self.exc = exc
        self.client: _FakeClient | None = None
        self.client_kwargs: dict = {}

    def Client(self, **kwargs):
        self.client_kwargs = kwargs
        self.client = _FakeClient(resp=self.resp, exc=self.exc, **kwargs)
        return self.client


def test_with_default_ua_adds_and_is_overridable():
    assert _with_default_ua(None) == {"User-Agent": DEFAULT_USER_AGENT}
    assert _with_default_ua({"User-Agent": "mine"}) == {"User-Agent": "mine"}


@pytest.mark.parametrize("url,expected", [
    ("http://example.com/x", ("example.com", 80)),
    ("https://example.com/x", ("example.com", 443)),
    ("http://127.0.0.1:1/x", ("127.0.0.1", 1)),
    ("https://host:8443/x", ("host", 8443)),
])
def test_endpoint_defaults_the_port_by_scheme(url, expected):
    assert _endpoint(url) == expected


def test_is_error_is_status_driven():
    assert not HttpResponse(200, "OK", b"", "u").is_error
    assert not HttpResponse(302, "Found", b"", "u").is_error
    assert HttpResponse(404, "Not Found", b"", "u").is_error
    assert HttpResponse(500, "Server Error", b"", "u").is_error


# The load-bearing behavior: a non-2xx is reported as a status, never raised.
# curl exits 0 and prints the body for a 404 while wget exits 8, so only the
# caller can decide, and an earlier raise_for_status() here made both fail.
def test_error_status_is_returned_not_raised(monkeypatch):
    fake = _FakeHttpx(resp=_FakeResponse(404, "Not Found", b"nope"))
    monkeypatch.setattr(http_mod, "httpx", fake)
    resp = _http_request("http://x.test/missing")
    assert (resp.status, resp.reason, resp.body) == (404, "Not Found", b"nope")
    assert resp.is_error


def test_transport_error_becomes_http_connect_error(monkeypatch):
    fake = _FakeHttpx(exc=_FakeTransportError("refused"))
    monkeypatch.setattr(http_mod, "httpx", fake)
    with pytest.raises(HttpConnectError) as excinfo:
        _http_request("http://127.0.0.1:1/x")
    assert (excinfo.value.host, excinfo.value.port) == ("127.0.0.1", 1)


def test_redirects_are_not_followed_by_default(monkeypatch):
    fake = _FakeHttpx(resp=_FakeResponse(200, "OK", b"ok"))
    monkeypatch.setattr(http_mod, "httpx", fake)
    _http_request("http://x.test/r")
    assert fake.client_kwargs["follow_redirects"] is False
    _http_request("http://x.test/r", follow_redirects=True)
    assert fake.client_kwargs["follow_redirects"] is True


def test_missing_httpx_raises_with_the_extra_hint(monkeypatch):
    monkeypatch.setattr(http_mod, "httpx", None)
    with pytest.raises(ImportError, match=r"mirage\[http\]"):
        _http_request("http://x.test/x")
