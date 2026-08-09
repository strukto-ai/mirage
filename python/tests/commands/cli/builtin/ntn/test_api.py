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

from mirage.commands.cli.builtin.ntn.api import METHODS, api, classify
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.core.notion.config import NotionConfig
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


def test_malformed_typed_input_is_a_usage_error():
    with pytest.raises(UsageError) as caught:
        sorted_inputs("a:={")
    assert str(caught.value) == "a:= must be valid JSON"


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
async def test_data_must_be_an_object():
    with pytest.raises(UsageError) as caught:
        await api(
            CLIInvocation(CONFIG, texts=("v1/search", ), flags={"data": "[]"}))
    assert str(caught.value) == "--data must be a JSON object"


@pytest.mark.asyncio
async def test_data_and_inline_body_conflict():
    with pytest.raises(UsageError) as caught:
        await api(
            CLIInvocation(CONFIG,
                          texts=("v1/search", "a=1"),
                          flags={"data": "{}"}))
    assert str(caught.value) == "request body must come from one source"


@pytest.mark.asyncio
async def test_body_infers_post_and_output_is_compact(monkeypatch):
    seen: dict[str, Any] = {}

    async def fake_post(
            config: NotionConfig,
            path: str,
            body: dict[str, Any] | None = None,
            extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
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
