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

# Exit codes and messages are pinned against curl 8.14.1 in
# debian:stable-slim. The load-bearing rule: an HTTP error status is a
# successful transfer to curl, and only -f/--fail turns it into a failure.

import asyncio

import pytest

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.general.curl import curl
from mirage.commands.builtin.utils.http import HttpConnectError, HttpResponse
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError


def _ok(body: bytes = b"hello body",
        status: int = 200,
        reason: str = "OK") -> HttpResponse:
    return HttpResponse(status=status,
                        reason=reason,
                        body=body,
                        url="http://x.test/f")


def _stub(monkeypatch, resp=None, exc=None) -> list[dict]:
    calls: list[dict] = []

    def fake(url,
             method="GET",
             headers=None,
             data=None,
             timeout=30,
             follow_redirects=False):
        calls.append({
            "url": url,
            "method": method,
            "headers": headers,
            "data": data,
            "follow_redirects": follow_redirects,
        })
        if exc is not None:
            raise exc
        return resp if resp is not None else _ok()

    monkeypatch.setitem(curl.__wrapped__.__globals__, "_http_request", fake)
    return calls


def _run(*texts: str,
         dispatch=None,
         cwd=None,
         **flags) -> tuple[bytes, object]:
    opts = CommandOpts(dispatch=dispatch, cwd=cwd or "/", flags=flags)
    body, io = asyncio.run(curl(NOOPAccessor(), [], list(texts), opts))
    if body is None:
        return b"", io
    return bytes(body), io


def test_get_returns_body(monkeypatch):
    _stub(monkeypatch)
    body, io = _run("http://x.test/f")
    assert body == b"hello body"
    assert io.exit_code == 0


def test_missing_url_is_usage_error_exit_2():
    with pytest.raises(UsageError) as excinfo:
        asyncio.run(curl(NOOPAccessor(), [], [], CommandOpts()))
    assert excinfo.value.exit_code == 2
    assert "no URL specified" in str(excinfo.value)


def test_404_prints_body_and_exits_zero(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"not found", 404, "Not Found"))
    body, io = _run("http://x.test/missing")
    assert io.exit_code == 0
    assert body == b"not found"


def test_fail_flag_turns_404_into_exit_22(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"not found", 404, "Not Found"))
    _body, io = _run("http://x.test/missing", fail=True)
    assert io.exit_code == 22
    assert b"curl: (22) The requested URL returned error: 404" in io.stderr


def test_silent_keeps_exit_22_without_message(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"x", 404, "Not Found"))
    _body, io = _run("http://x.test/missing", fail=True, s=True)
    assert io.exit_code == 22
    assert io.stderr == b""


def test_show_error_restores_message(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"x", 404, "Not Found"))
    _body, io = _run("http://x.test/missing", fail=True, s=True, S=True)
    assert io.exit_code == 22
    assert b"curl: (22)" in io.stderr


def test_refused_connection_is_exit_7(monkeypatch):
    _stub(monkeypatch, exc=HttpConnectError("127.0.0.1", 1))
    _body, io = _run("http://127.0.0.1:1/f")
    assert io.exit_code == 7
    assert b"curl: (7) Failed to connect to 127.0.0.1 port 1" in io.stderr


def test_redirects_only_followed_with_L(monkeypatch):
    calls = _stub(monkeypatch)
    _run("http://x.test/r")
    assert calls[0]["follow_redirects"] is False
    _run("http://x.test/r", L=True)
    assert calls[1]["follow_redirects"] is True


def test_o_writes_and_prints_nothing(monkeypatch):
    _stub(monkeypatch)
    body, io = _run("http://x.test/f", o="/tmp/out.txt")
    assert body == b""
    assert io.writes == {"/tmp/out.txt": b"hello body"}


def test_o_on_404_writes_the_error_body(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"not found", 404, "Not Found"))
    _body, io = _run("http://x.test/missing", o="/tmp/e.txt")
    assert io.exit_code == 0
    assert io.writes == {"/tmp/e.txt": b"not found"}


def test_fail_flag_writes_nothing(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"not found", 404, "Not Found"))
    _body, io = _run("http://x.test/missing", o="/tmp/e.txt", fail=True)
    assert io.exit_code == 22
    assert io.writes == {}


def test_header_and_method_reach_the_request(monkeypatch):
    calls = _stub(monkeypatch)
    _run("http://x.test/echo", X="PUT", H="X-Mirage-Test: yes")
    assert calls[0]["method"] == "PUT"
    assert calls[0]["headers"] == {"X-Mirage-Test": "yes"}


def test_data_implies_post(monkeypatch):
    calls = _stub(monkeypatch)
    _run("http://x.test/echo", d="payload=42")
    assert calls[0]["method"] == "POST"
    assert calls[0]["data"] == b"payload=42"


def test_write_failure_is_exit_23_with_strerror(monkeypatch):
    _stub(monkeypatch)

    async def boom(op, scope, **kwargs):
        raise FileNotFoundError("/tmp/nope/out.txt")

    _body, io = _run("http://x.test/f", o="/tmp/nope/out.txt", dispatch=boom)
    assert io.exit_code == 23
    expected = b"curl: (23) /tmp/nope/out.txt: No such file or directory"
    assert expected in io.stderr


def test_write_failure_keeps_read_only_wording(monkeypatch):
    _stub(monkeypatch)

    async def boom(op, scope, **kwargs):
        raise PermissionError("mount '/ro/' is read-only")

    _body, io = _run("http://x.test/f", o="/ro/out.txt", dispatch=boom)
    assert io.exit_code == 23
    assert b"read-only" in io.stderr


def test_write_failure_silenced_by_s(monkeypatch):
    _stub(monkeypatch)

    async def boom(op, scope, **kwargs):
        raise FileNotFoundError("/tmp/nope/out.txt")

    _body, io = _run("http://x.test/f",
                     o="/tmp/nope/out.txt",
                     dispatch=boom,
                     s=True)
    assert io.exit_code == 23
    assert io.stderr == b""


def test_form_field_uses_the_form_helper(monkeypatch):
    calls: list[dict] = []

    def fake_form(url,
                  method="POST",
                  form_data=None,
                  headers=None,
                  timeout=30,
                  follow_redirects=False):
        calls.append({"url": url, "method": method, "form_data": form_data})
        return _ok(b"form ok")

    monkeypatch.setitem(curl.__wrapped__.__globals__, "_http_form_request",
                        fake_form)
    body, io = _run("http://x.test/form", F="field=value")
    assert io.exit_code == 0
    assert body == b"form ok"
    assert calls[0]["form_data"] == {"field": "value"}


def test_exit_code_constants_match_curl():
    # The backend package re-exports the command function, shadowing the
    # submodule of the same name, so the module namespace is reached through
    # the unwrapped function (see CLAUDE.md).
    g = curl.__wrapped__.__globals__
    assert (g["EXIT_NO_URL"], g["EXIT_CONNECT"], g["EXIT_HTTP_ERROR"],
            g["EXIT_WRITE"]) == (2, 7, 22, 23)
