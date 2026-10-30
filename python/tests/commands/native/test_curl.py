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
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.io.types import IOResult, materialize
from mirage.types import PathSpec
from mirage.workspace.files import Files

HEADERS = (("Content-Type", "text/plain"), ("Content-Length", "10"))


def _ok(
    body: bytes = b"hello body", status: int = 200, reason: str = "OK"
) -> HttpResponse:
    return HttpResponse(
        status=status,
        reason=reason,
        body=body,
        url="http://x.test/f",
        headers=HEADERS,
    )


def _stub(monkeypatch, resp=None, exc=None) -> list[dict]:
    calls: list[dict] = []

    async def fake(
        url,
        method="GET",
        headers=None,
        data=None,
        timeout=30,
        follow_redirects=False,
        verify=True,
        cookies=None,
        stream=False,
    ):
        calls.append(
            {
                "url": url,
                "method": method,
                "headers": headers,
                "data": data,
                "timeout": timeout,
                "follow_redirects": follow_redirects,
                "verify": verify,
                "cookies": cookies,
            }
        )
        if exc is not None:
            raise exc
        return resp if resp is not None else _ok()

    monkeypatch.setitem(curl.__wrapped__.__globals__, "http_request", fake)
    return calls


def _run(
    *texts: str, dispatch=None, cwd=None, **flags
) -> tuple[bytes, object]:
    base = cwd or "/"
    spec = PathSpec(virtual=base, directory=base, vfs_path="", resolved=False)
    vfs = Files(dispatch, ledger=False) if dispatch is not None else None
    ctx = Context(vfs=vfs, cwd=spec, flags=flags)

    async def run() -> tuple[bytes, IOResult]:
        body, io = await curl(NOOPAccessor(), [], list(texts), ctx)
        return await materialize(body), io

    return asyncio.run(run())


def _run_writing(
    *texts: str, **flags
) -> tuple[bytes, IOResult, dict[str, bytes]]:
    """Run curl with a dispatcher that keeps what each write sent."""
    written: dict[str, bytes] = {}

    async def dispatch(op, scope, **kwargs):
        written[scope.virtual] = await materialize(kwargs["data"])

    body, io = _run(*texts, dispatch=dispatch, **flags)
    return body, io, written


def test_get_returns_body(monkeypatch):
    _stub(monkeypatch)
    body, io = _run("http://x.test/f")
    assert body == b"hello body"
    assert io.exit_code == 0


def test_missing_url_is_usage_error_exit_2():
    with pytest.raises(UsageError) as excinfo:
        asyncio.run(curl(NOOPAccessor(), [], [], Context()))
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
    _body, io = _run(
        "http://x.test/missing", fail=True, silent=True, show_error=True
    )
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
    body, io, written = _run_writing("http://x.test/f", output="/tmp/out.txt")
    assert body == b""
    assert written == {"/tmp/out.txt": b"hello body"}


def test_o_on_404_writes_the_error_body(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"not found", 404, "Not Found"))
    _body, io, written = _run_writing(
        "http://x.test/missing", output="/tmp/e.txt"
    )
    assert io.exit_code == 0
    assert written == {"/tmp/e.txt": b"not found"}


def test_fail_flag_writes_nothing(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"not found", 404, "Not Found"))
    _body, io, written = _run_writing(
        "http://x.test/missing", output="/tmp/e.txt", fail=True
    )
    assert io.exit_code == 22
    assert written == {}


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

    _body, io = _run(
        "http://x.test/f", output="/tmp/nope/out.txt", dispatch=boom
    )
    assert io.exit_code == 23
    expected = b"curl: (23) /tmp/nope/out.txt: No such file or directory"
    assert expected in io.stderr


async def _boom(op, scope, **kwargs):
    raise RuntimeError("backend bug")


@pytest.mark.parametrize("option", ["output", "dump_header"])
def test_write_error_outside_the_fs_family_propagates(monkeypatch, option):
    _stub(monkeypatch)
    with pytest.raises(RuntimeError, match="backend bug"):
        _run("http://x.test/f", dispatch=_boom, **{option: "/tmp/out"})


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

    _body, io = _run(
        "http://x.test/f",
        output="/tmp/nope/out.txt",
        dispatch=boom,
        silent=True,
    )
    assert io.exit_code == 23
    assert io.stderr == b""


def test_form_field_uses_the_form_helper(monkeypatch):
    calls: list[dict] = []

    async def fake_form(
        url,
        method="POST",
        form_data=None,
        headers=None,
        timeout=30,
        follow_redirects=False,
        verify=True,
        cookies=None,
        stream=False,
    ):
        calls.append({"url": url, "method": method, "form_data": form_data})
        return _ok(b"form ok")

    monkeypatch.setitem(
        curl.__wrapped__.__globals__, "http_form_request", fake_form
    )
    body, io = _run("http://x.test/form", form="field=value")
    assert io.exit_code == 0
    assert body == b"form ok"
    assert calls[0]["form_data"] == {"field": "value"}


def test_exit_code_constants_match_curl():
    # The backend package re-exports the command function, shadowing the
    # submodule of the same name, so the module namespace is reached through
    # the unwrapped function (see CLAUDE.md).
    g = curl.__wrapped__.__globals__
    assert (
        g["EXIT_USAGE"],
        g["EXIT_CONNECT"],
        g["EXIT_HTTP_ERROR"],
        g["EXIT_WRITE"],
    ) == (2, 7, 22, 23)


# Pinned against curl 8.7.1 / 8.14.1 (byte shapes captured with `cat -ve`
# against a local python http.server). Header names render lowercase in
# both hosts because fetch never exposes the wire casing, and the status
# line always says HTTP/1.1 because fetch cannot observe the version.
HINT = "curl: try 'curl --help' or 'curl --manual' for more information\n"
RESPONSE_DUMP = (
    "HTTP/1.1 200 OK\r\ncontent-length: 10\r\ncontent-type: text/plain\r\n\r\n"
)


def test_long_spellings_reach_the_request(monkeypatch):
    calls = _stub(monkeypatch)
    _run(
        "http://x.test/echo",
        request="PUT",
        header="X-Mirage-Test: yes",
        user_agent="agent/1",
    )
    assert calls[0]["method"] == "PUT"
    assert calls[0]["headers"] == {
        "X-Mirage-Test": "yes",
        "User-Agent": "agent/1",
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
        "curl: option --max-time: expected a positive numerical parameter\n"
    )
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
        "Warning: (-d, --data) and HEAD (-I, --head).\n"
    )


def test_silent_mutes_the_head_with_data_warning_but_keeps_exit_2(monkeypatch):
    # -s mutes a warning and -S does not bring one back (curl 8.7.1).
    _stub(monkeypatch)
    _body, io = _run(
        "http://x.test/f", head=True, data="x", silent=True, show_error=True
    )
    assert io.exit_code == 2
    assert io.stderr == b""


def test_head_with_form_adds_an_option_error_silent_never_mutes(monkeypatch):
    _stub(monkeypatch)
    _body, io = _run("http://x.test/f", head=True, form="a=b", silent=True)
    assert io.exit_code == 2
    assert io.stderr.decode() == (
        "curl: option -F: is badly used here\n" + HINT
    )


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
    assert io.stderr == (
        b"curl: (28) Operation timed out after 2001 "
        b"milliseconds with 0 bytes received\n"
    )


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
        "> \r\n"
        + "".join(f"< {line}\r\n" for line in RESPONSE_DUMP.split("\r\n")[:-1])
    )


def test_verbose_shows_custom_headers_and_the_body_headers(monkeypatch):
    _stub(monkeypatch)
    _body, io = _run(
        "http://x.test:8080/f",
        verbose=True,
        silent=True,
        request="POST",
        header="X-Test: 1",
        user_agent="agent/1",
        data="a=1",
    )
    assert io.stderr.decode().split("< ")[0] == (
        "> POST /f HTTP/1.1\r\n"
        "> Host: x.test:8080\r\n"
        "> User-Agent: agent/1\r\n"
        "> Accept: */*\r\n"
        "> X-Test: 1\r\n"
        "> Content-Length: 3\r\n"
        "> Content-Type: application/x-www-form-urlencoded\r\n"
        "> \r\n"
    )


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
    monkeypatch,
):
    # -d adds curl's own Content-Type to the request, and -v shows the one
    # that is sent: a -H Content-Type takes its place in the custom slot
    # and no default follows (curl 8.7.1).
    calls = _stub(monkeypatch)
    _run("http://x.test/f", data="a=1")
    assert calls[0]["headers"] == {
        "Content-Type": "application/x-www-form-urlencoded"
    }
    calls = _stub(monkeypatch)
    _body, io = _run(
        "http://x.test/f",
        data="{}",
        header="Content-Type: application/json",
        verbose=True,
        silent=True,
    )
    assert calls[0]["headers"] == {"Content-Type": "application/json"}
    assert io.stderr.decode().split("< ")[0] == (
        "> POST /f HTTP/1.1\r\n"
        "> Host: x.test\r\n"
        "> User-Agent: Mozilla/5.0 (compatible; mirage/1.0)\r\n"
        "> Accept: */*\r\n"
        "> Content-Type: application/json\r\n"
        "> Content-Length: 2\r\n"
        "> \r\n"
    )


def test_include_prints_the_headers_before_the_body(monkeypatch):
    _stub(monkeypatch)
    body, _io = _run("http://x.test/f", include=True)
    assert body.decode() == RESPONSE_DUMP + "hello body"


HOP_DUMP = "HTTP/1.1 302 Found\r\nlocation: /f\r\n\r\n"


def _redirected(method: str = "GET") -> HttpResponse:
    hop = HttpResponse(
        status=302,
        reason="Found",
        body=b"302: Found",
        url="http://x.test/r",
        headers=(("Location", "/f"),),
        method=method,
    )
    return replace(_ok(), history=(hop,))


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
        line
        for line in lines
        if line.startswith("> GET") or line.startswith("< HTTP/")
    ] == [
        "> GET /r HTTP/1.1",
        "< HTTP/1.1 302 Found",
        "> GET /f HTTP/1.1",
        "< HTTP/1.1 200 OK",
    ]


def test_verbose_with_location_drops_the_body_headers_after_a_switch(
    monkeypatch,
):
    # The body rode the POST; the GET a 302 turns it into carries none,
    # so its request block shows no Content-Length or Content-Type.
    _stub(monkeypatch, resp=_redirected(method="POST"))
    _body, io = _run(
        "http://x.test/r", location=True, verbose=True, data="a=1"
    )
    first, second = io.stderr.decode().split("< HTTP/1.1")[:2]
    assert "> POST /r HTTP/1.1" in first
    assert "> Content-Length: 3" in first
    assert "> GET /f HTTP/1.1" in second
    assert "Content-" not in second.split("> \r\n")[0]


def test_include_with_output_writes_headers_and_body(monkeypatch):
    _stub(monkeypatch)
    body, io, written = _run_writing(
        "http://x.test/f", include=True, output="/tmp/out.txt"
    )
    assert body == b""
    assert written == {"/tmp/out.txt": (RESPONSE_DUMP + "hello body").encode()}


# -D/--dump-header and -k/--insecure, pinned against curl 8.14.1 in
# debian:stable-slim. The header block is the one -i prints, with its
# documented divergences (lowercase sorted names, HTTP/1.1).


def test_dump_header_dash_prints_the_headers_before_the_body(monkeypatch):
    _stub(monkeypatch)
    body, io, written = _run_writing("http://x.test/f", dump_header="-")
    assert body.decode() == RESPONSE_DUMP + "hello body"
    assert written == {}


def test_dump_header_file_gets_the_headers_and_stdout_the_body(monkeypatch):
    _stub(monkeypatch)
    body, io, written = _run_writing("http://x.test/f", dump_header="/tmp/h")
    assert body == b"hello body"
    assert written == {"/tmp/h": RESPONSE_DUMP.encode()}


def test_dump_header_file_is_written_through_the_dispatcher(monkeypatch):
    _stub(monkeypatch)
    written: list[tuple[str, bytes]] = []

    async def dispatch(op, scope, **kwargs):
        written.append((scope.virtual, kwargs["data"]))

    body, io = _run("http://x.test/f", dump_header="/tmp/h", dispatch=dispatch)
    assert body == b"hello body"
    assert written == [("/tmp/h", RESPONSE_DUMP.encode())]
    assert io.exit_code == 0


def test_dump_header_dash_with_output_leaves_only_headers_on_stdout(
    monkeypatch,
):
    _stub(monkeypatch)
    body, io, written = _run_writing(
        "http://x.test/f", dump_header="-", output="/tmp/b"
    )
    assert body.decode() == RESPONSE_DUMP
    assert written == {"/tmp/b": b"hello body"}


def test_dump_header_and_output_naming_one_file_leave_the_body(monkeypatch):
    _stub(monkeypatch)
    _body, io, written = _run_writing(
        "http://x.test/f", dump_header="/tmp/x", output="/tmp/x"
    )
    assert written == {"/tmp/x": b"hello body"}


@pytest.mark.parametrize(
    "flag,tail", [("include", "hello body"), ("head", "")]
)
def test_dump_header_dash_beside_include_prints_each_line_twice(
    monkeypatch, flag, tail
):
    _stub(monkeypatch)
    body, _io = _run("http://x.test/f", dump_header="-", **{flag: True})
    lines = RESPONSE_DUMP.split("\r\n")[:-1]
    assert (
        body.decode()
        == "".join(f"{line}\r\n{line}\r\n" for line in lines) + tail
    )


def test_dump_header_with_location_dumps_every_hop(monkeypatch):
    _stub(monkeypatch, resp=_redirected())
    body, _io = _run("http://x.test/r", location=True, dump_header="-")
    assert body.decode() == HOP_DUMP + RESPONSE_DUMP + "hello body"


def test_dump_header_survives_fail(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"not found", 404, "Not Found"))
    body, io = _run(
        "http://x.test/missing", dump_header="-", fail=True, silent=True
    )
    assert io.exit_code == 22
    assert body == (
        b"HTTP/1.1 404 Not Found\r\ncontent-length: 10\r\n"
        b"content-type: text/plain\r\n\r\n"
    )


def test_dump_header_write_failure_is_exit_23(monkeypatch):
    _stub(monkeypatch)

    async def boom(op, scope, **kwargs):
        raise FileNotFoundError("/tmp/nope/h")

    body, io = _run(
        "http://x.test/f", dump_header="/tmp/nope/h", dispatch=boom
    )
    assert io.exit_code == 23
    assert body == b""
    assert io.stderr == b"curl: (23) /tmp/nope/h: No such file or directory\n"


def test_insecure_turns_certificate_verification_off(monkeypatch):
    calls = _stub(monkeypatch)
    _run("https://x.test/f")
    _run("https://x.test/f", insecure=True)
    assert [call["verify"] for call in calls] == [True, False]


JAR = (
    "# Netscape HTTP Cookie File\n"
    "# https://curl.se/docs/http-cookies.html\n"
    "# This file was generated by libcurl! Edit at your own risk.\n\n"
)
JAR_URL = "http://127.0.0.1:8080/jar/x"


def _run_jar(
    files: dict[str, str] | None = None, refuse: bool = False, **flags
) -> tuple[bytes, IOResult, dict[str, str]]:
    """Run curl over a dispatcher holding ``files``.

    Reads serve them, writes land in them, a path outside them reads as
    missing, and ``refuse`` fails every write.
    """
    held = {} if files is None else files

    async def dispatch(op, scope, **kwargs):
        if op == "read":
            if scope.virtual not in held:
                raise FileNotFoundError(scope.virtual)
            return held[scope.virtual].encode(), IOResult()
        if refuse:
            raise FileNotFoundError(scope.virtual)
        held[scope.virtual] = (await materialize(kwargs["data"])).decode()
        return None, IOResult()

    body, io = _run(JAR_URL, dispatch=dispatch, **flags)
    return body, io, held


def _cookies_sent(httpx_mock) -> list[str | None]:
    return [r.headers.get("cookie") for r in httpx_mock.get_requests()]


def test_c_writes_what_a_login_set_and_b_sends_it_back(httpx_mock):
    httpx_mock.add_response(
        url=JAR_URL,
        headers=[("Set-Cookie", "session=s3cr3t; Path=/; HttpOnly")],
    )
    _, _, files = _run_jar(cookie_jar="/data/jar")
    assert files["/data/jar"] == (
        f"{JAR}#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\ts3cr3t\n"
    )
    httpx_mock.add_response(url=JAR_URL)
    _, io, _ = _run_jar(files, cookie=["/data/jar"])
    assert io.exit_code == 0
    assert _cookies_sent(httpx_mock) == [None, "session=s3cr3t"]


def test_a_missing_cookie_file_reads_as_none(httpx_mock):
    httpx_mock.add_response(url=JAR_URL)
    _, io, _ = _run_jar(cookie=["/data/nope"])
    assert (io.exit_code, _cookies_sent(httpx_mock)) == (0, [None])


def test_literal_data_joins_with_a_semicolon_and_a_typed_cookie_replaces_it(
    httpx_mock,
):
    httpx_mock.add_response(url=JAR_URL, is_reusable=True)
    _run_jar(cookie=["a=1", " b=2"])
    _run_jar(cookie=["a=1"], header=["Cookie: x=1"])
    assert _cookies_sent(httpx_mock) == ["a=1;b=2", "x=1"]


@pytest.mark.parametrize("engine,after", [([""], "h=1"), (None, None)])
def test_a_redirect_cookie_crosses_only_with_the_jar_on(
    httpx_mock, engine, after
):
    httpx_mock.add_response(
        url=JAR_URL,
        status_code=302,
        headers=[("Location", "/jar/next"), ("Set-Cookie", "h=1; Path=/")],
    )
    httpx_mock.add_response(url="http://127.0.0.1:8080/jar/next")
    flags = {"location": True} | ({} if engine is None else {"cookie": engine})
    _run_jar(**flags)
    assert _cookies_sent(httpx_mock) == [None, after]


def test_c_writes_the_jar_when_the_reader_lets_the_body_go(httpx_mock):
    httpx_mock.add_response(
        url=JAR_URL, text="body\n", headers=[("Set-Cookie", "z=1")]
    )
    held: dict[str, str] = {}

    async def dispatch(op, scope, **kwargs):
        held[scope.virtual] = (await materialize(kwargs["data"])).decode()
        return None, IOResult()

    spec = PathSpec(virtual="/", directory="/", vfs_path="", resolved=False)
    ctx = Context(
        vfs=Files(dispatch, ledger=False),
        cwd=spec,
        flags={"cookie_jar": "/data/jar"},
    )

    async def run() -> bytes:
        body, _ = await curl(NOOPAccessor(), [], [JAR_URL], ctx)
        first = await anext(aiter(body))
        await body.aclose()
        return first

    assert asyncio.run(run()) == b"body\n"
    assert (
        held["/data/jar"] == f"{JAR}127.0.0.1\tFALSE\t/jar/\tFALSE\t0\tz\t1\n"
    )


def test_c_dash_writes_the_jar_to_stdout_after_the_body_and_w(httpx_mock):
    httpx_mock.add_response(
        url=JAR_URL, text="body\n", headers=[("Set-Cookie", "z=1")]
    )
    body, _, _ = _run_jar(cookie_jar="-", write_out="W\n")
    jar = f"{JAR}127.0.0.1\tFALSE\t/jar/\tFALSE\t0\tz\t1\n"
    assert body == f"body\nW\n{jar}".encode()


def test_v_shows_the_jar_cookie_line_after_accept_per_hop(httpx_mock):
    httpx_mock.add_response(
        url=JAR_URL,
        status_code=302,
        headers=[("Location", "/jar/next"), ("Set-Cookie", "h=1; Path=/")],
    )
    httpx_mock.add_response(url="http://127.0.0.1:8080/jar/next")
    _, io, _ = _run_jar(
        location=True, verbose=True, cookie=["y=2", ""], header=["X-A: 1"]
    )
    requests = [
        line
        for line in io.stderr.decode().split("\r\n")
        if line.startswith("> ") and not line.startswith("> Host")
    ]
    assert requests == [
        "> GET /jar/x HTTP/1.1",
        "> User-Agent: Mozilla/5.0 (compatible; mirage/1.0)",
        "> Accept: */*",
        "> Cookie: y=2",
        "> X-A: 1",
        "> ",
        "> GET /jar/next HTTP/1.1",
        "> User-Agent: Mozilla/5.0 (compatible; mirage/1.0)",
        "> Accept: */*",
        "> Cookie: h=1; y=2",
        "> X-A: 1",
        "> ",
    ]


def test_v_shows_a_typed_cookie_only_on_the_hops_it_went_to(httpx_mock):
    httpx_mock.add_response(
        url=JAR_URL,
        status_code=302,
        headers=[("Location", "http://localhost:8080/jar/next")],
    )
    httpx_mock.add_response(
        url="http://localhost:8080/jar/next",
        status_code=302,
        headers=[("Location", "http://127.0.0.1:8080/jar/end")],
    )
    httpx_mock.add_response(url="http://127.0.0.1:8080/jar/end")
    _, io, _ = _run_jar(location=True, verbose=True, header=["Cookie: x=1"])
    shown = [
        line
        for line in io.stderr.decode().split("\r\n")
        if line.startswith(("> GET", "> Cookie"))
    ]
    assert shown == [
        "> GET /jar/x HTTP/1.1",
        "> Cookie: x=1",
        "> GET /jar/next HTTP/1.1",
        "> GET /jar/end HTTP/1.1",
        "> Cookie: x=1",
    ]
    assert _cookies_sent(httpx_mock) == ["x=1", None, "x=1"]


def test_the_jar_is_saved_after_a_failed_transfer_and_unsaved_quietly(
    httpx_mock,
):
    httpx_mock.add_response(
        url=JAR_URL, status_code=401, headers=[("Set-Cookie", "f=1; Path=/")]
    )
    _, io, files = _run_jar(fail=True, silent=True, cookie_jar="/data/jar")
    assert io.exit_code == 22
    assert files["/data/jar"] == f"{JAR}127.0.0.1\tFALSE\t/\tFALSE\t0\tf\t1\n"
    httpx_mock.add_response(url=JAR_URL, text="ok")
    body, io, _ = _run_jar(refuse=True, cookie_jar="/ro/jar")
    assert (io.exit_code, io.stderr, body) == (0, b"", b"ok")
