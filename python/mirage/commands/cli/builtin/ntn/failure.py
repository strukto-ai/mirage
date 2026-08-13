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

from collections.abc import Awaitable, Callable

from mirage.commands.cli.types import CLIInvocation
from mirage.core.notion._client import NotionAPIError
from mirage.core.notion.config import NotionConfig
from mirage.io.types import ByteSource, IOResult

VerbFn = Callable[[CLIInvocation[NotionConfig]],
                  Awaitable[tuple[ByteSource | None, IOResult]]]

FAILED = "error: Public API request failed"
# 401 is the one status upstream does not itemize: it drops the
# parenthesis entirely and answers with an actionable hint and its own
# exit code, because a token problem is the user's to fix and naming
# `unauthorized` twice would not help them do it.
UNAUTHORIZED_HINT = ("  hint: Set NOTION_API_TOKEN, or run `ntn login` to "
                     "reuse a saved workspace token.\n")
API_ERROR_EXIT = 5
UNAUTHORIZED_EXIT = 4
UNAUTHORIZED = 401

# Upstream is a Rust program and renders the reason phrase from its http
# crate's full table, but only the statuses Notion itself documents can
# reach a caller, so those are the ones pinned here (probed one by one
# against ntn 0.21.9). An unlisted status keeps the number and drops the
# phrase rather than inventing one.
HTTP_REASON = {
    400: "Bad Request",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
}


class HintedAPIError(NotionAPIError):
    """An API failure a verb has its own second line for.

    Upstream pairs some refusals with a `  hint:` line naming what the
    operand could have been, which is the verb's knowledge rather than
    the transport's, so it is attached here instead of in the client.

    Args:
        base (NotionAPIError): the failure as the client raised it.
        hint (str): the complete hint line, newline included.
    """

    def __init__(self, base: NotionAPIError, hint: str) -> None:
        super().__init__(str(base), status=base.status, code=base.code)
        self.hint = hint


def source_hint(ref: str) -> str:
    """Upstream's hint for an operand that was neither kind of id.

    Args:
        ref (str): the id the operand reduced to.

    Returns:
        str: the complete hint line, newline included.
    """
    return (f"  hint: Could not find a data source or database with ID "
            f"`{ref}`. Check that the ID or URL points to a data source or "
            f"database shared with your integration.\n")


def api_failure(exc: NotionAPIError) -> tuple[str, int]:
    """Render an API failure the way the real ntn binary renders it.

    Args:
        exc (NotionAPIError): the failure raised by the notion client.

    Returns:
        tuple[str, int]: the complete stderr text and the exit status.
    """
    hint = exc.hint if isinstance(exc, HintedAPIError) else ""
    if exc.status == UNAUTHORIZED:
        return f"{FAILED}: {exc}\n{UNAUTHORIZED_HINT}", UNAUTHORIZED_EXIT
    named = []
    if exc.status is not None:
        named.append(str(exc.status))
        reason = HTTP_REASON.get(exc.status)
        if reason is not None:
            named.append(reason)
    if exc.code is not None:
        named.append(exc.code)
    detail = f" ({' '.join(named)})" if named else ""
    return f"{FAILED}{detail}: {exc}\n{hint}", API_ERROR_EXIT


async def guarded(
        fn: VerbFn, inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    """Run one ntn verb, answering an API failure in upstream's voice.

    Every leaf is wrapped with this in the tree, because the executor's
    own fallback prints `ntn <verb>: <message>` and exits 1 (the GNU
    shape it owes every other CLI), which drops the status, the reason
    phrase and Notion's machine-readable code: exactly the three fields
    a caller branches on. `tests/commands/cli/builtin/ntn/test_failure.py`
    fails if a leaf is left unwrapped.

    Args:
        fn (VerbFn): the leaf handler being guarded.
        inv (CLIInvocation): the line's one invocation record.

    Returns:
        tuple[ByteSource | None, IOResult]: the verb's own output, or the
            rendered failure.
    """
    try:
        return await fn(inv)
    except NotionAPIError as failed:
        stderr, code = api_failure(failed)
        return None, IOResult(stderr=stderr.encode(), exit_code=code)
