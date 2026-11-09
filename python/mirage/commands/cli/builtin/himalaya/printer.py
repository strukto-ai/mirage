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

import logging
from collections.abc import Awaitable, Callable
from functools import wraps
from typing import Any

from mirage.accessor.email import EmailAccessor
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import MailboxNotFound
from mirage.core.render.json import compact_json_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

logger = logging.getLogger(__name__)

SUGGESTION = "Run with --log-level to enable more verbose logs"

LeafFn = Callable[
    [EmailAccessor, list[PathSpec], list[str], Context],
    Awaitable[tuple[ByteSource | None, IOResult]],
]


class ChainedError(ValueError):
    """A failure that names what caused it, as `Caused by:` lines.

    Args:
        message (str): what failed.
        sources (tuple[str, ...]): the causes, outermost first.
    """

    def __init__(self, message: str, sources: tuple[str, ...] = ()) -> None:
        super().__init__(message)
        self.sources = sources


def rendered(fl: FlagView, document: Any, text: str) -> bytes:
    """A command's output in the mode the line asked for.

    Args:
        fl (FlagView): the leaf's parsed flags.
        document (JsonValue): the output under ``--json``.
        text (str): the output otherwise.
    """
    if fl.as_bool("json"):
        return compact_json_bytes(document)
    return text.encode()


def notice(fl: FlagView, text: str) -> bytes:
    """A one-line confirmation.

    Args:
        fl (FlagView): the leaf's parsed flags.
        text (str): what happened.
    """
    return rendered(fl, {"message": text}, f"{text}\n")


def error_report(exc: Exception, as_json: bool) -> bytes:
    """A failure as the upstream program prints it, to standard output.

    Args:
        exc (Exception): what went wrong.
        as_json (bool): whether the line asked for JSON.
    """
    message = (
        f"IMAP {exc.verb} failed: {exc.detail}"
        if isinstance(exc, MailboxNotFound)
        else str(exc)
    )
    sources = list(exc.sources) if isinstance(exc, ChainedError) else []
    if as_json:
        return compact_json_bytes(
            {"error": message, "sources": sources, "backtrace": None}
        )
    text = f"Error: {message}"
    if sources:
        causes = "\n".join(f" - {source.strip()}" for source in sources)
        text += f"\n\nCaused by:\n{causes}"
    return f"{text}\n\nSuggestions:\n - {SUGGESTION}\n".encode()


def guarded(fn: LeafFn) -> LeafFn:
    """Report a leaf's failure the way the upstream program does.

    Args:
        fn (LeafFn): the leaf.
    """

    @wraps(fn)
    async def call(
        accessor: EmailAccessor,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> tuple[ByteSource | None, IOResult]:
        try:
            return await fn(accessor, paths, texts, ctx)
        except Exception as exc:
            logger.debug("himalaya failed: %s", exc)
            as_json = FlagView(ctx.flags, ctx.spec).as_bool("json")
            return error_report(exc, as_json), IOResult(exit_code=1)

    return call
