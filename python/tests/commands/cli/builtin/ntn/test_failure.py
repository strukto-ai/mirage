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

from functools import partial

import pytest

from mirage.commands.cli.builtin.ntn import NTN
from mirage.commands.cli.builtin.ntn.failure import (HintedAPIError,
                                                     api_failure, guarded,
                                                     source_hint)
from mirage.commands.cli.types import CLISpec
from mirage.core.notion._client import NotionAPIError
from mirage.io.types import IOResult

# Every line here was printed by ntn 0.21.9 against a server returning that
# status with Notion's own error envelope. The two shapes upstream has for a
# missing message (it echoes the raw body instead) are absent on purpose: the
# client synthesizes a message before raising, so they cannot be reached.
PROBED = [
    (400, "validation_error", "block_id should be a valid uuid.",
     "error: Public API request failed (400 Bad Request validation_error): "
     "block_id should be a valid uuid.\n", 5),
    (403, "restricted_resource", "sample message.",
     "error: Public API request failed (403 Forbidden restricted_resource): "
     "sample message.\n", 5),
    (404, "object_not_found", "Could not find block with ID: x.",
     "error: Public API request failed (404 Not Found object_not_found): "
     "Could not find block with ID: x.\n", 5),
    (409, "conflict_error", "sample message.",
     "error: Public API request failed (409 Conflict conflict_error): "
     "sample message.\n", 5),
    (429, "rate_limited", "sample message.",
     "error: Public API request failed (429 Too Many Requests rate_limited): "
     "sample message.\n", 5),
    (500, "internal_server_error", "sample message.",
     "error: Public API request failed "
     "(500 Internal Server Error internal_server_error): sample message.\n",
     5),
    (502, "bad_gateway", "sample message.",
     "error: Public API request failed (502 Bad Gateway bad_gateway): "
     "sample message.\n", 5),
    (503, "service_unavailable", "sample message.",
     "error: Public API request failed "
     "(503 Service Unavailable service_unavailable): sample message.\n", 5),
    (504, "gateway_timeout", "sample message.",
     "error: Public API request failed (504 Gateway Timeout gateway_timeout): "
     "sample message.\n", 5),
]


@pytest.mark.parametrize("status,code,message,stderr,exit_code", PROBED)
def test_api_failure_matches_the_real_cli(status: int, code: str, message: str,
                                          stderr: str, exit_code: int) -> None:
    failed = NotionAPIError(message, status=status, code=code)
    assert api_failure(failed) == (stderr, exit_code)


def test_unauthorized_drops_the_parenthesis_and_exits_four() -> None:
    # Upstream's one special case: a token problem is the user's to fix, so it
    # answers with a hint instead of itemizing a status it already implied.
    failed = NotionAPIError("API token is invalid.",
                            status=401,
                            code="unauthorized")
    stderr, code = api_failure(failed)
    assert stderr == ("error: Public API request failed: API token is "
                      "invalid.\n  hint: Set NOTION_API_TOKEN, or run `ntn "
                      "login` to reuse a saved workspace token.\n")
    assert code == 4


def test_missing_code_keeps_the_status_and_reason() -> None:
    failed = NotionAPIError("no code here.", status=404)
    assert api_failure(failed) == (
        "error: Public API request failed (404 Not Found): no code here.\n", 5)


def test_unlisted_status_keeps_the_number_and_drops_the_phrase() -> None:
    failed = NotionAPIError("odd one.", status=418, code="teapot")
    assert api_failure(failed) == (
        "error: Public API request failed (418 teapot): odd one.\n", 5)


def test_hint_rides_the_same_render() -> None:
    base = NotionAPIError("Could not find data source with ID: y.",
                          status=404,
                          code="object_not_found")
    stderr, code = api_failure(HintedAPIError(base, source_hint("y")))
    assert stderr == (
        "error: Public API request failed (404 Not Found object_not_found): "
        "Could not find data source with ID: y.\n  hint: Could not find a "
        "data source or database with ID `y`. Check that the ID or URL points "
        "to a data source or database shared with your integration.\n")
    assert code == 5


@pytest.mark.asyncio
async def test_guarded_renders_an_api_error_and_passes_others_through(
) -> None:
    caught = await guarded(_raise_api, None)
    assert caught[0] is None
    assert caught[1].exit_code == 5
    with pytest.raises(ValueError):
        await guarded(_raise_other, None)


@pytest.mark.asyncio
async def test_guarded_returns_a_successful_verb_untouched() -> None:
    assert await guarded(_succeed, None) == (None, _OK)


def test_every_ntn_leaf_is_guarded() -> None:
    # The wrap is the whole mechanism, so a verb added without it still runs,
    # still exits 0 on success, and simply reports its API failures in the
    # executor's generic shape, which nothing notices until someone reads a
    # 404 from it.
    unguarded = [
        " ".join(path) for path, leaf in _leaves(NTN, ())
        if not _is_guarded(leaf)
    ]
    assert unguarded == []


_OK = IOResult()


async def _raise_api(_inv: None) -> tuple[None, IOResult]:
    raise NotionAPIError("boom.", status=404, code="object_not_found")


async def _raise_other(_inv: None) -> tuple[None, IOResult]:
    raise ValueError("not an API failure")


async def _succeed(_inv: None) -> tuple[None, IOResult]:
    return None, _OK


def _leaves(node: CLISpec,
            path: tuple[str, ...]) -> list[tuple[tuple[str, ...], CLISpec]]:
    here = path + (node.name, )
    if node.fn is not None:
        return [(here, node)]
    found: list[tuple[tuple[str, ...], CLISpec]] = []
    for child in node.subcommands:
        found.extend(_leaves(child, here))
    return found


def _is_guarded(leaf: CLISpec) -> bool:
    return isinstance(leaf.fn, partial) and leaf.fn.func is guarded
