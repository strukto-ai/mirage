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

from typing import Any

import pytest

from mirage.commands.cli.builtin.ntn.api import (METHODS, InlineRefusal, api,
                                                 classify)
from mirage.commands.cli.types import CLIInvocation
from mirage.core.notion.config import NotionConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import materialize
from mirage.types import JsonValue

CONFIG = NotionConfig(api_key="secret")

# The three accumulators classify() sorts one input token into.
Sorted = tuple[dict[str, JsonValue], dict[str, str], dict[str, str]]


def sorted_inputs(*tokens: str) -> Sorted:
    """Run tokens through classify and return the three accumulators.

    Args:
        *tokens (str): raw `ntn api` inputs.
    """
    body: dict[str, JsonValue] = {}
    params: dict[str, str] = {}
    headers: dict[str, str] = {}
    for token in tokens:
        classify(token, body, params, headers)
    return body, params, headers


def test_precedence_is_order_sensitive():
    # `path:=json` beats `name==value` beats `Header:Value` beats
    # `path=value`, so a value carrying one separator cannot be
    # reclassified by another appearing later in it.
    body, params, headers = sorted_inputs("a:=1", "b==2", "C:3", "d=4")
    assert body == {"a": 1, "d": "4"}
    assert params == {"b": "2"}
    assert headers == {"C": "3"}


def test_a_header_value_may_contain_a_colon():
    _body, _params, headers = sorted_inputs("X-Trace:a:b:c")
    assert headers == {"X-Trace": "a:b:c"}


def test_malformed_typed_input_carries_serdes_own_words():
    # Upstream is a Rust binary and reports serde_json's message, which
    # python's json could not produce ("Expecting property name enclosed
    # in double quotes"). The whole token is echoed, Rust-debug quoted.
    with pytest.raises(InlineRefusal) as caught:
        sorted_inputs("a:={")
    assert caught.value.detail == ('invalid JSON value in "a:={": '
                                   "EOF while parsing an object at line 1 "
                                   "column 1")


def test_an_input_with_no_separator_is_named_unexpected():
    with pytest.raises(InlineRefusal) as caught:
        sorted_inputs("foo")
    assert caught.value.detail == 'unexpected input: "foo"'


@pytest.mark.asyncio
async def test_inline_headers_reach_the_request(monkeypatch):
    # Probed on the wire against the real ntn 0.21.9, which sends
    # `X-Foo:bar` as a request header. Recognizing the syntax and then
    # dropping the value is the failure this pins.
    seen: dict[str, Any] = {}

    async def fake_get(
            config: NotionConfig,
            path: str,
            params: dict[str, Any] | None = None,
            extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
        seen["headers"] = extra_headers
        return {"ok": True}

    monkeypatch.setitem(api.__globals__, "notion_get", fake_get)
    await api(
        CLIInvocation(CONFIG, texts=("v1/search", "X-Foo:bar", "X-Two:baz")))
    assert seen["headers"] == {"X-Foo": "bar", "X-Two": "baz"}


@pytest.mark.asyncio
async def test_no_inline_header_sends_none(monkeypatch):
    seen: dict[str, Any] = {}

    async def fake_get(
            config: NotionConfig,
            path: str,
            params: dict[str, Any] | None = None,
            extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
        seen["headers"] = extra_headers
        return {"ok": True}

    monkeypatch.setitem(api.__globals__, "notion_get", fake_get)
    await api(CLIInvocation(CONFIG, texts=("v1/search", )))
    assert seen["headers"] is None


@pytest.mark.asyncio
async def test_malformed_data_matches_upstream_exactly():
    # Probed against ntn 0.21.9: exit 1 with this wording, which is
    # neither python's raw JSONDecodeError nor a generic usage error.
    out, io = await api(
        CLIInvocation(CONFIG, texts=("v1/search", ), flags={"data": "{"}))
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b"error: Invalid JSON from --data\n"


@pytest.mark.asyncio
async def test_a_non_object_data_is_sent_rather_than_refused(monkeypatch):
    # There is no client-side object check upstream: probed on the wire,
    # `-d '[]'` POSTs the array. mirage used to refuse it as a usage
    # error, which meant a line the real CLI accepts exited 2 here.
    seen: dict[str, Any] = {}

    async def fake_post(
            config: NotionConfig,
            path: str,
            body: JsonValue = None,
            extra_headers: dict[str, str] | None = None,
            params: dict[str, Any] | None = None) -> dict[str, Any]:
        seen["body"] = body
        return {"ok": True}

    monkeypatch.setitem(METHODS, "POST", fake_post)
    _out, io = await api(
        CLIInvocation(CONFIG, texts=("v1/search", ), flags={"data": "[]"}))
    assert io.exit_code == 0
    assert seen["body"] == []


@pytest.mark.asyncio
async def test_an_empty_data_object_still_posts(monkeypatch):
    # `{}` is falsy, and inferring the method from truthiness sent this
    # as a GET. Upstream posts it: the presence of a body source decides
    # the method, not whether the body has anything in it.
    seen: dict[str, Any] = {}

    async def fake_post(
            config: NotionConfig,
            path: str,
            body: JsonValue = None,
            extra_headers: dict[str, str] | None = None,
            params: dict[str, Any] | None = None) -> dict[str, Any]:
        seen["body"] = body
        return {"ok": True}

    monkeypatch.setitem(METHODS, "POST", fake_post)
    await api(
        CLIInvocation(CONFIG, texts=("v1/search", ), flags={"data": "{}"}))
    assert seen["body"] == {}


@pytest.mark.asyncio
async def test_data_and_inline_body_conflict():
    _out, io = await api(
        CLIInvocation(CONFIG, texts=("v1/search", "a=1"), flags={"data":
                                                                 "{}"}))
    assert io.exit_code == 5
    assert io.stderr.decode() == (
        "error: Request body can come from only one source, but got: "
        "--data, inline body inputs.\n"
        "  hint: Use only one of: stdin JSON, `--data`, or "
        "`path=value` / `path:=json` inputs.\n")


@pytest.mark.asyncio
async def test_the_pipe_is_a_body_source_and_outranks_data():
    # Upstream names the sources in a fixed order and validates the pipe
    # first, so a malformed pipe wins over a conflict it is part of.
    _out, io = await api(
        CLIInvocation(CONFIG,
                      texts=("v1/search", ),
                      flags={"data": "{}"},
                      stdin=yield_bytes(b'{"q":1}')))
    assert io.exit_code == 5
    assert io.stderr.decode().splitlines()[0] == (
        "error: Request body can come from only one source, but got: "
        "stdin JSON, --data.")


@pytest.mark.asyncio
async def test_malformed_stdin_is_its_own_exit_one():
    _out, io = await api(
        CLIInvocation(CONFIG, texts=("v1/search", ), stdin=yield_bytes(b"{")))
    assert io.exit_code == 1
    assert io.stderr == b"error: Invalid JSON from stdin\n"


@pytest.mark.asyncio
async def test_blank_stdin_is_not_a_body_source(monkeypatch):
    # The conformance harness closes stdin and every other line would
    # otherwise report a conflict it never asked for.
    seen: dict[str, Any] = {}

    async def fake_post(
            config: NotionConfig,
            path: str,
            body: JsonValue = None,
            extra_headers: dict[str, str] | None = None,
            params: dict[str, Any] | None = None) -> dict[str, Any]:
        seen["body"] = body
        return {"ok": True}

    monkeypatch.setitem(METHODS, "POST", fake_post)
    _out, io = await api(
        CLIInvocation(CONFIG,
                      texts=("v1/search", ),
                      flags={"data": "{}"},
                      stdin=yield_bytes(b"  \n")))
    assert io.exit_code == 0
    assert seen["body"] == {}


@pytest.mark.asyncio
async def test_an_empty_data_names_its_own_refusal():
    _out, io = await api(
        CLIInvocation(CONFIG, texts=("v1/search", ), flags={"data": "  "}))
    assert io.exit_code == 5
    assert io.stderr.decode() == (
        "error: --data requires a valid JSON value.\n"
        "  hint: Pass a JSON string such as `--data '{\"foo\":\"bar\"}'`, "
        "a file such as `--data @body.json`, or stdin with `--data @-`.\n")


@pytest.mark.asyncio
async def test_an_inline_refusal_carries_the_hint_and_exits_five():
    _out, io = await api(CLIInvocation(CONFIG, texts=("v1/search", "a:={")))
    assert io.exit_code == 5
    assert io.stderr.decode() == (
        "error: Failed to parse inline request input: invalid JSON value "
        'in "a:={": EOF while parsing an object at line 1 column 1\n'
        "  hint: Use `Header:Value`, `name==value`, `path=value`, or "
        "`path:=json`.\n")


@pytest.mark.asyncio
async def test_a_query_parameter_survives_a_non_get(monkeypatch):
    # `name==value` is a query parameter whatever the method is. The
    # non-GET path used to drop params entirely.
    seen: dict[str, Any] = {}

    async def fake_post(
            config: NotionConfig,
            path: str,
            body: JsonValue = None,
            extra_headers: dict[str, str] | None = None,
            params: dict[str, Any] | None = None) -> dict[str, Any]:
        seen["params"] = params
        return {"ok": True}

    monkeypatch.setitem(METHODS, "POST", fake_post)
    await api(CLIInvocation(CONFIG, texts=("v1/search", "a=1", "q==2")))
    assert seen["params"] == {"q": "2"}


@pytest.mark.asyncio
async def test_body_infers_post_and_output_is_compact(monkeypatch):
    seen: dict[str, Any] = {}

    async def fake_post(
            config: NotionConfig,
            path: str,
            body: JsonValue = None,
            extra_headers: dict[str, str] | None = None,
            params: dict[str, Any] | None = None) -> dict[str, Any]:
        seen["path"] = path
        seen["body"] = body
        return {"b": 1, "a": 2}

    # The non-GET path dispatches through METHODS, which captured the
    # real function at import, so patching the module global alone would
    # not be seen.
    monkeypatch.setitem(METHODS, "POST", fake_post)
    out, _io = await api(CLIInvocation(CONFIG, texts=("v1/search", "query=x")))
    assert seen["path"] == "/search"
    assert seen["body"] == {"query": "x"}
    # Compact and key-sorted, the upstream serializer for `ntn api`,
    # with the trailing newline the real binary emits.
    assert (await materialize(out)) == b'{"a":2,"b":1}\n'


@pytest.mark.asyncio
async def test_delete_is_a_reachable_method(monkeypatch):
    # `DELETE /v1/blocks/{id}` is the only delete verb the public API has,
    # and it is the one the MCP tool surface exposes as
    # API-delete-a-block, so a table without it leaves an agent no way to
    # remove anything. It reached the user as `unsupported method: DELETE`
    # (exit 2) where the real binary trashes the block.
    seen: dict[str, Any] = {}

    async def fake_delete(
            config: NotionConfig,
            path: str,
            body: JsonValue = None,
            extra_headers: dict[str, str] | None = None,
            params: dict[str, Any] | None = None) -> dict[str, Any]:
        seen["path"] = path
        seen["body"] = body
        return {"object": "block", "in_trash": True}

    monkeypatch.setitem(METHODS, "DELETE", fake_delete)
    out, io = await api(
        CLIInvocation(CONFIG,
                      texts=("v1/blocks/abc-123", ),
                      flags={"method": "delete"}))
    assert io.exit_code == 0
    assert seen["path"] == "/blocks/abc-123"
    # No body source on the line, so nothing is invented for one.
    assert seen["body"] is None
    assert (await materialize(out)) == b'{"in_trash":true,"object":"block"}\n'
