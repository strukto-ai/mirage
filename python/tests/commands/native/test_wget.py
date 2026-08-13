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

# Exit codes and messages are pinned against GNU Wget 1.25.0 in
# debian:stable-slim. Unlike curl, wget treats any 4xx/5xx as a failure with no
# flag needed, and its progress report goes to stderr rather than stdout.

import asyncio

import pytest

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.general.wget import wget
from mirage.commands.builtin.utils.http import HttpConnectError, HttpResponse
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError


def _ok(body: bytes = b"file-body",
        status: int = 200,
        reason: str = "OK") -> HttpResponse:
    return HttpResponse(status=status,
                        reason=reason,
                        body=body,
                        url="http://x.test/f")


def _stub(monkeypatch, resp=None, exc=None) -> list[str]:
    calls: list[str] = []

    def fake(url, headers=None, timeout=30, follow_redirects=True):
        calls.append(url)
        if exc is not None:
            raise exc
        return resp if resp is not None else _ok()

    monkeypatch.setitem(wget.__wrapped__.__globals__, "_http_get", fake)
    return calls


def _run(*texts: str,
         dispatch=None,
         cwd=None,
         **flags) -> tuple[bytes, object]:
    opts = CommandOpts(dispatch=dispatch, cwd=cwd or "/", flags=flags)
    body, io = asyncio.run(wget(NOOPAccessor(), [], list(texts), opts))
    if body is None:
        return b"", io
    return bytes(body), io


def test_missing_url_is_usage_error_exit_1():
    with pytest.raises(UsageError) as excinfo:
        asyncio.run(wget(NOOPAccessor(), [], [], CommandOpts()))
    assert excinfo.value.exit_code == 1
    assert "wget: missing URL" in str(excinfo.value)


def test_saves_url_basename_and_reports_on_stderr(monkeypatch):
    _stub(monkeypatch)
    body, io = _run("http://x.test/path/doc.pdf")
    assert body == b""
    assert io.writes == {"doc.pdf": b"file-body"}
    assert b"'doc.pdf' saved [9/9]" in io.stderr


def test_args_O_sets_destination(monkeypatch):
    _stub(monkeypatch)
    _body, io = _run("http://x.test/f", args_O="/tmp/dest.bin")
    assert io.writes == {"/tmp/dest.bin": b"file-body"}


def test_quiet_silences_the_report(monkeypatch):
    _stub(monkeypatch)
    _body, io = _run("http://x.test/f", args_O="/tmp/d", q=True)
    assert io.exit_code == 0
    assert io.stderr == b""


def test_404_is_exit_8_and_creates_an_empty_destination(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"not found", 404, "Not Found"))
    _body, io = _run("http://x.test/missing", args_O="/tmp/w.txt")
    assert io.exit_code == 8
    assert b"ERROR 404: Not Found." in io.stderr
    assert io.writes == {"/tmp/w.txt": b""}


def test_quiet_keeps_exit_8_without_message(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"x", 404, "Not Found"))
    _body, io = _run("http://x.test/missing", args_O="/tmp/w.txt", q=True)
    assert io.exit_code == 8
    assert io.stderr == b""


def test_refused_connection_is_exit_4(monkeypatch):
    _stub(monkeypatch, exc=HttpConnectError("127.0.0.1", 1))
    _body, io = _run("http://127.0.0.1:1/f", args_O="/tmp/w.txt")
    assert io.exit_code == 4
    assert b"failed: Connection refused." in io.stderr


def test_spider_reports_on_stderr_without_writing(monkeypatch):
    _stub(monkeypatch)
    body, io = _run("http://x.test/exists", spider=True)
    assert io.exit_code == 0
    assert body == b""
    assert io.writes == {}
    assert io.stderr == b"Remote file exists.\n"


def test_spider_on_404_is_exit_8_with_broken_link(monkeypatch):
    _stub(monkeypatch, resp=_ok(b"x", 404, "Not Found"))
    _body, io = _run("http://x.test/missing", spider=True)
    assert io.exit_code == 8
    assert io.stderr == b"Remote file does not exist -- broken link!!!\n"


def test_spider_quiet_is_silent(monkeypatch):
    _stub(monkeypatch)
    _body, io = _run("http://x.test/exists", spider=True, q=True)
    assert io.exit_code == 0
    assert io.stderr == b""


def test_write_failure_is_exit_1_naming_the_path(monkeypatch):
    _stub(monkeypatch)

    async def boom(op, scope, **kwargs):
        raise FileNotFoundError("/tmp/nope/w.txt")

    _body, io = _run("http://x.test/f",
                     args_O="/tmp/nope/w.txt",
                     dispatch=boom)
    assert io.exit_code == 1
    assert b"/tmp/nope/w.txt" in io.stderr


def test_write_failure_silenced_by_q(monkeypatch):
    _stub(monkeypatch)

    async def boom(op, scope, **kwargs):
        raise FileNotFoundError("/tmp/nope/w.txt")

    _body, io = _run("http://x.test/f",
                     args_O="/tmp/nope/w.txt",
                     dispatch=boom,
                     q=True)
    assert io.exit_code == 1
    assert io.stderr == b""


def test_exit_code_constants_match_wget():
    # The backend package re-exports the command function, shadowing the
    # submodule of the same name, so the module namespace is reached through
    # the unwrapped function (see CLAUDE.md).
    g = wget.__wrapped__.__globals__
    assert (g["EXIT_GENERIC"], g["EXIT_NETWORK"],
            g["EXIT_SERVER_ERROR"]) == (1, 4, 8)
