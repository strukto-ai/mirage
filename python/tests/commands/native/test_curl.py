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
from dataclasses import replace

import pytest

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.errors import HttpConnectError, HttpTimeoutError
from mirage.commands.builtin.general.curl import curl
from mirage.commands.builtin.utils.http import HttpResponse
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.types import PathSpec

HEADERS = (("Content-Type", "text/plain"), ("Content-Length", "10"))


def _ok(body: bytes = b"hello body",
        status: int = 200,
        reason: str = "OK") -> HttpResponse:
    return HttpResponse(status=status,
                        reason=reason,
                        body=body,
                        url="http://x.test/f",
                        headers=HEADERS)


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
            "timeout": timeout,
            "follow_redirects": follow_redirects,
        })
        if exc is not None:
            raise exc
        return resp if resp is not None else _ok()

    monkeypatch.setitem(curl.__wrapped__.__globals__, "http_request", fake)
    return calls


def _run(*texts: str,
         dispatch=None,
         cwd=None,
         **flags) -> tuple[bytes, object]:
    base = cwd or "/"
    spec = PathSpec(virtual=base, directory=base, vfs_path="", resolved=False)
    opts = CommandOpts(dispatch=dispatch, cwd=spec, flags=flags)
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
    _body, io = _run("http://x.test/missing", fail=True, silent=True)
    assert io.exit_code == 22
    assert io.stderr == b""


def test_show_error_restores_message(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"x", 404, "Not Found"))
    _body, io = _run("http://x.test/missing",
                     fail=True,
                     silent=True,
                     show_error=True)
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
    _run("http://x.test/r", location=True)
    assert calls[1]["follow_redirects"] is True


def test_o_writes_and_prints_nothing(monkeypatch):
    _stub(monkeypatch)
    body, io = _run("http://x.test/f", output="/tmp/out.txt")
    assert body == b""
    assert io.writes == {"/tmp/out.txt": b"hello body"}


def test_o_on_404_writes_the_error_body(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"not found", 404, "Not Found"))
    _body, io = _run("http://x.test/missing", output="/tmp/e.txt")
    assert io.exit_code == 0
    assert io.writes == {"/tmp/e.txt": b"not found"}


def test_fail_flag_writes_nothing(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"not found", 404, "Not Found"))
    _body, io = _run("http://x.test/missing", output="/tmp/e.txt", fail=True)
    assert io.exit_code == 22
    assert io.writes == {}


def test_header_and_method_reach_the_request(monkeypatch):
    calls = _stub(monkeypatch)
    _run("http://x.test/echo", request="PUT", header="X-Mirage-Test: yes")
    assert calls[0]["method"] == "PUT"
    assert calls[0]["headers"] == {"X-Mirage-Test": "yes"}


def test_data_implies_post(monkeypatch):
    calls = _stub(monkeypatch)
    _run("http://x.test/echo", data="payload=42")
    assert calls[0]["method"] == "POST"
    assert calls[0]["data"] == b"payload=42"


def test_write_failure_is_exit_23_with_strerror(monkeypatch):
    _stub(monkeypatch)

    async def boom(op, scope, **kwargs):
        raise FileNotFoundError("/tmp/nope/out.txt")

    _body, io = _run("http://x.test/f",
                     output="/tmp/nope/out.txt",
                     dispatch=boom)
    assert io.exit_code == 23
    expected = b"curl: (23) /tmp/nope/out.txt: No such file or directory"
    assert expected in io.stderr


def test_write_failure_keeps_read_only_wording(monkeypatch):
    _stub(monkeypatch)

    async def boom(op, scope, **kwargs):
        raise PermissionError("mount '/ro/' is read-only")

    _body, io = _run("http://x.test/f", output="/ro/out.txt", dispatch=boom)
    assert io.exit_code == 23
    assert b"read-only" in io.stderr


def test_write_failure_silenced_by_s(monkeypatch):
    _stub(monkeypatch)

    async def boom(op, scope, **kwargs):
        raise FileNotFoundError("/tmp/nope/out.txt")

    _body, io = _run("http://x.test/f",
                     output="/tmp/nope/out.txt",
                     dispatch=boom,
                     silent=True)
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

    monkeypatch.setitem(curl.__wrapped__.__globals__, "http_form_request",
                        fake_form)
    body, io = _run("http://x.test/form", form="field=value")
    assert io.exit_code == 0
    assert body == b"form ok"
    assert calls[0]["form_data"] == {"field": "value"}


def test_exit_code_constants_match_curl():
    # The backend package re-exports the command function, shadowing the
    # submodule of the same name, so the module namespace is reached through
    # the unwrapped function (see CLAUDE.md).
    g = curl.__wrapped__.__globals__
    assert (g["EXIT_USAGE"], g["EXIT_CONNECT"], g["EXIT_HTTP_ERROR"],
            g["EXIT_WRITE"]) == (2, 7, 22, 23)


# Pinned against curl 8.7.1 / 8.14.1 (byte shapes captured with `cat -ve`
# against a local python http.server). Header names render lowercase in
# both hosts because fetch never exposes the wire casing, and the status
# line always says HTTP/1.1 because fetch cannot observe the version.
HINT = "curl: try 'curl --help' or 'curl --manual' for more information\n"
RESPONSE_DUMP = ("HTTP/1.1 200 OK\r\n"
                 "content-length: 10\r\n"
                 "content-type: text/plain\r\n"
                 "\r\n")


def test_long_spellings_reach_the_request(monkeypatch):
    calls = _stub(monkeypatch)
    _run("http://x.test/echo",
         request="PUT",
         header="X-Mirage-Test: yes",
         user_agent="agent/1")
    assert calls[0]["method"] == "PUT"
    assert calls[0]["headers"] == {
        "X-Mirage-Test": "yes",
        "User-Agent": "agent/1"
    }


def test_max_time_reaches_the_request_in_seconds(monkeypatch):
    calls = _stub(monkeypatch)
    _run("http://x.test/f", max_time=2.5)
    assert calls[0]["timeout"] == 2.5


def test_negative_max_time_is_refused_before_any_transfer(monkeypatch):
    # curl 8.7.1: `option -m: expected a positive numerical parameter`,
    # exit 2, and -s does not mute an option error.
    calls = _stub(monkeypatch)
    with pytest.raises(UsageError) as excinfo:
        _run("http://x.test/f", max_time=-1, silent=True)
    assert excinfo.value.exit_code == 2
    assert str(excinfo.value).startswith(
        "curl: option --max-time: expected a positive numerical parameter\n")
    assert calls == []


def test_head_with_data_is_refused_with_curls_warning(monkeypatch):
    # curl 8.7.1 warns about two methods for one request and exits 2
    # before any transfer.
    calls = _stub(monkeypatch)
    body, io = _run("http://x.test/f", head=True, data="x")
    assert calls == []
    assert body == b""
    assert io.exit_code == 2
    assert io.stderr.decode() == (
        "Warning: You can only select one HTTP request method! "
        "You asked for both POST \n"
        "Warning: (-d, --data) and HEAD (-I, --head).\n")


def test_silent_mutes_the_head_with_data_warning_but_keeps_exit_2(monkeypatch):
    # -s mutes a warning and -S does not bring one back (curl 8.7.1).
    _stub(monkeypatch)
    _body, io = _run("http://x.test/f",
                     head=True,
                     data="x",
                     silent=True,
                     show_error=True)
    assert io.exit_code == 2
    assert io.stderr == b""


def test_head_with_form_adds_an_option_error_silent_never_mutes(monkeypatch):
    _stub(monkeypatch)
    _body, io = _run("http://x.test/f", head=True, form="a=b", silent=True)
    assert io.exit_code == 2
    assert io.stderr.decode() == ("curl: option -F: is badly used here\n" +
                                  HINT)


def test_max_time_zero_disables_the_deadline(monkeypatch):
    # curl reads zero as "no limit" (curl 8.7.1: `-m 0` completes a
    # transfer that `-m .1` fails with 28), so no deadline reaches the
    # client.
    calls = _stub(monkeypatch)
    _run("http://x.test/f", max_time=0)
    assert calls[0]["timeout"] is None


def test_timeout_is_exit_28(monkeypatch):
    _stub(monkeypatch, exc=HttpTimeoutError("x.test", 80, 2001))
    body, io = _run("http://x.test/f", max_time=2)
    assert body == b""
    assert io.exit_code == 28
    assert io.stderr == (b"curl: (28) Operation timed out after 2001 "
                         b"milliseconds with 0 bytes received\n")


def test_silent_timeout_keeps_exit_28_without_message(monkeypatch):
    _stub(monkeypatch, exc=HttpTimeoutError("x.test", 80, 2001))
    _body, io = _run("http://x.test/f", max_time=2, silent=True)
    assert io.exit_code == 28
    assert io.stderr == b""


def test_verbose_dumps_request_and_response_headers_on_stderr(monkeypatch):
    _stub(monkeypatch)
    body, io = _run("http://x.test/f?q=1", verbose=True)
    assert body == b"hello body"
    assert io.exit_code == 0
    assert io.stderr.decode() == (
        "> GET /f?q=1 HTTP/1.1\r\n"
        "> Host: x.test\r\n"
        "> User-Agent: Mozilla/5.0 (compatible; mirage/1.0)\r\n"
        "> Accept: */*\r\n"
        "> \r\n" + "".join(f"< {line}\r\n"
                           for line in RESPONSE_DUMP.split("\r\n")[:-1]))


def test_verbose_shows_custom_headers_and_the_body_headers(monkeypatch):
    _stub(monkeypatch)
    _body, io = _run("http://x.test:8080/f",
                     verbose=True,
                     silent=True,
                     request="POST",
                     header="X-Test: 1",
                     user_agent="agent/1",
                     data="a=1")
    assert io.stderr.decode().split("< ")[0] == (
        "> POST /f HTTP/1.1\r\n"
        "> Host: x.test:8080\r\n"
        "> User-Agent: agent/1\r\n"
        "> Accept: */*\r\n"
        "> X-Test: 1\r\n"
        "> Content-Length: 3\r\n"
        "> Content-Type: application/x-www-form-urlencoded\r\n"
        "> \r\n")


def test_head_prints_the_headers_and_sends_head(monkeypatch):
    calls = _stub(monkeypatch, resp=_ok(b""))
    body, io = _run("http://x.test/f", head=True)
    assert calls[0]["method"] == "HEAD"
    assert body.decode() == RESPONSE_DUMP
    assert io.exit_code == 0


def test_head_with_explicit_get_drops_the_body(monkeypatch):
    # curl -I with -X GET still prints the headers alone (curl 8.7.1): the
    # body a GET carries is discarded, not appended.
    calls = _stub(monkeypatch)
    body, _io = _run("http://x.test/f", head=True, request="GET")
    assert calls[0]["method"] == "GET"
    assert body.decode() == RESPONSE_DUMP


def test_data_sends_the_form_content_type_unless_a_header_names_one(
        monkeypatch):
    # -d adds curl's own Content-Type to the request, and -v shows the one
    # that is sent: a -H Content-Type takes its place in the custom slot
    # and no default follows (curl 8.7.1).
    calls = _stub(monkeypatch)
    _run("http://x.test/f", data="a=1")
    assert calls[0]["headers"] == {
        "Content-Type": "application/x-www-form-urlencoded"
    }
    calls = _stub(monkeypatch)
    _body, io = _run("http://x.test/f",
                     data="{}",
                     header="Content-Type: application/json",
                     verbose=True,
                     silent=True)
    assert calls[0]["headers"] == {"Content-Type": "application/json"}
    assert io.stderr.decode().split("< ")[0] == (
        "> POST /f HTTP/1.1\r\n"
        "> Host: x.test\r\n"
        "> User-Agent: Mozilla/5.0 (compatible; mirage/1.0)\r\n"
        "> Accept: */*\r\n"
        "> Content-Type: application/json\r\n"
        "> Content-Length: 2\r\n"
        "> \r\n")


def test_include_prints_the_headers_before_the_body(monkeypatch):
    _stub(monkeypatch)
    body, _io = _run("http://x.test/f", include=True)
    assert body.decode() == RESPONSE_DUMP + "hello body"


HOP_DUMP = "HTTP/1.1 302 Found\r\nlocation: /f\r\n\r\n"


def _redirected(method: str = "GET") -> HttpResponse:
    hop = HttpResponse(status=302,
                       reason="Found",
                       body=b"302: Found",
                       url="http://x.test/r",
                       headers=(("Location", "/f"), ),
                       method=method)
    return replace(_ok(), history=(hop, ))


def test_include_with_location_prints_every_hops_headers(monkeypatch):
    # curl 8.7.1 `-iL`: each hop's header block, then the final body
    # alone; the redirect's own body is never written.
    _stub(monkeypatch, resp=_redirected())
    body, _io = _run("http://x.test/r", location=True, include=True)
    assert body.decode() == HOP_DUMP + RESPONSE_DUMP + "hello body"


def test_head_with_location_prints_every_hops_headers(monkeypatch):
    _stub(monkeypatch, resp=_redirected())
    body, _io = _run("http://x.test/r", location=True, head=True)
    assert body.decode() == HOP_DUMP + RESPONSE_DUMP


def test_verbose_with_location_traces_each_request(monkeypatch):
    _stub(monkeypatch, resp=_redirected())
    _body, io = _run("http://x.test/r", location=True, verbose=True)
    lines = io.stderr.decode().split("\r\n")
    assert [
        line for line in lines
        if line.startswith("> GET") or line.startswith("< HTTP/")
    ] == [
        "> GET /r HTTP/1.1", "< HTTP/1.1 302 Found", "> GET /f HTTP/1.1",
        "< HTTP/1.1 200 OK"
    ]


def test_verbose_with_location_drops_the_body_headers_after_a_switch(
        monkeypatch):
    # The body rode the POST; the GET a 302 turns it into carries none,
    # so its request block shows no Content-Length or Content-Type.
    _stub(monkeypatch, resp=_redirected(method="POST"))
    _body, io = _run("http://x.test/r",
                     location=True,
                     verbose=True,
                     data="a=1")
    first, second = io.stderr.decode().split("< HTTP/1.1")[:2]
    assert "> POST /r HTTP/1.1" in first
    assert "> Content-Length: 3" in first
    assert "> GET /f HTTP/1.1" in second
    assert "Content-" not in second.split("> \r\n")[0]


def test_include_with_output_writes_headers_and_body(monkeypatch):
    _stub(monkeypatch)
    body, io = _run("http://x.test/f", include=True, output="/tmp/out.txt")
    assert body == b""
    assert io.writes == {
        "/tmp/out.txt": (RESPONSE_DUMP + "hello body").encode()
    }
