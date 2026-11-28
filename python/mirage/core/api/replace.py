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

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar
from uuid import uuid4

from mirage.core.api.errors import ApiError

logger = logging.getLogger(__name__)

T = TypeVar("T")


def aside_name(name: str) -> str:
    """A name beside ``name`` that no other writer picks.

    Drawn from the process rather than the workspace's id source: the
    name lives in the service, where a seeded one would meet an earlier
    run's leftover.

    Args:
        name (str): the name set aside.
    """
    return f"{name}.mirage-{uuid4().hex}"


def _answered(exc: BaseException) -> bool:
    """Whether the service refused the request, so nothing it asked for
    happened. A dropped connection, a cancellation, a 5xx or a check run
    after the request may each follow a change that went through.

    Args:
        exc (BaseException): what the request raised.
    """
    return (
        isinstance(exc, ApiError)
        and exc.status is not None
        and exc.status < 500
    )


async def _quietly(step: Callable[[], Awaitable[Any]], what: str) -> None:
    """Run an undo step, logging its failure, so the error that called for
    it stays the one raised. A cancellation reaches the caller while the
    step runs on.

    Args:
        step (Callable[[], Awaitable[Any]]): the undo.
        what (str): what it does, for the log.
    """
    try:
        await asyncio.shield(step())
    except Exception as exc:
        logger.debug("could not %s: %s", what, exc)


async def _gone_after_all(gone: Callable[[], Awaitable[bool]]) -> bool:
    """Whether what a refused retire named is gone after all; a failed
    check counts as there.

    Args:
        gone (Callable[[], Awaitable[bool]]): the check.
    """
    try:
        return await asyncio.shield(gone())
    except Exception as exc:
        logger.debug("could not tell whether the retire went through: %s", exc)
        return False


async def set_aside(
    aside: Callable[[], Awaitable[T]],
    restore: Callable[[], Awaitable[Any]],
) -> T:
    """Move what holds a name aside, so an item can land on the name.

    A refusal leaves it where it was. Any other failure may follow a move
    that went through, so ``restore`` puts it back.

    Args:
        aside (Callable[[], Awaitable[T]]): the move aside, and any check
            of what it moved.
        restore (Callable[[], Awaitable[Any]]): what puts it back.

    Returns:
        T: what ``aside`` answered.
    """
    try:
        return await aside()
    except BaseException as exc:
        if not _answered(exc):
            await _quietly(restore, "restore the destination")
        raise


async def land_then_retire(
    land: Callable[[], Awaitable[T]],
    take_back: Callable[[T], Awaitable[Any]],
    retire: Callable[[], Awaitable[Any]],
    gone: Callable[[], Awaitable[bool]],
    restore: Callable[[], Awaitable[Any]] | None = None,
) -> T:
    """Land an item on a name, then retire what held the name before.

    What held it was set aside (``restore`` puts it back) or, on a service
    that keeps two items of one name, left beside the landing. A failed
    landing restores it. A failed retire takes the landing back and
    restores it, unless what it named is gone after all: a delete whose
    answer was lost went through, so the replace stands.

    Args:
        land (Callable[[], Awaitable[T]]): the move or copy onto the name.
        take_back (Callable[[T], Awaitable[Any]]): what undoes a landing.
        retire (Callable[[], Awaitable[Any]]): what deletes the item
            replaced.
        gone (Callable[[], Awaitable[bool]]): whether that item is gone.
        restore (Callable[[], Awaitable[Any]] | None): what puts a set
            aside item back, None when nothing was set aside.

    Returns:
        T: what ``land`` answered.
    """
    try:
        landed = await land()
    except BaseException:
        if restore is not None:
            await _quietly(restore, "restore the destination")
        raise
    try:
        await retire()
    except BaseException as exc:
        if await _gone_after_all(gone):
            if isinstance(exc, Exception):
                return landed
            raise
        await _quietly(lambda: take_back(landed), "take back the landing")
        if restore is not None:
            await _quietly(restore, "restore the destination")
        raise
    return landed
