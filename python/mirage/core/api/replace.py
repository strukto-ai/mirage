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

from mirage.core.api.constants import RETRIED_ANSWERS
from mirage.core.api.errors import ApiError

logger = logging.getLogger(__name__)

T = TypeVar("T")
V = TypeVar("V")


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
    after the request may each follow a change that went through, and so
    may a 404: a client that retries a 503 answers with what the retry
    met, after its first attempt moved the item.

    Args:
        exc (BaseException): what the request raised.
    """
    return (
        isinstance(exc, ApiError)
        and exc.status is not None
        and exc.status < 500
        and exc.status not in RETRIED_ANSWERS
    )


async def _quietly(step: Callable[[], Awaitable[Any]], what: str) -> None:
    """Run an undo step, logging its failure, so the error that called for
    it stays the one raised.

    Args:
        step (Callable[[], Awaitable[Any]]): the undo.
        what (str): what it does, for the log.
    """
    try:
        await step()
    except Exception as exc:
        logger.debug("could not %s: %s", what, exc)


async def _asked(check: Callable[[], Awaitable[V]], what: str) -> V | None:
    """Ask the service what a step whose answer was lost did, None when the
    question fails too.

    Args:
        check (Callable[[], Awaitable[V]]): the question.
        what (str): what it asks, for the log.
    """
    try:
        return await check()
    except Exception as exc:
        logger.debug("could not tell whether %s: %s", what, exc)
        return None


async def _undisturbed(steps: Callable[[], Awaitable[V]]) -> V:
    """Run an undo to its end, holding back a cancellation that arrives
    meanwhile until it has, then raising it: a cancellation between two
    steps would leave the first done and the second not.

    Args:
        steps (Callable[[], Awaitable[V]]): the undo.

    Returns:
        V: what the undo answered.
    """
    task = asyncio.ensure_future(steps())
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    if cancelled:
        raise asyncio.CancelledError
    return task.result()


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
            await _undisturbed(
                lambda: _quietly(restore, "restore the destination")
            )
        raise


async def _landing_failed(
    exc: BaseException,
    take_back: Callable[[T], Awaitable[Any]],
    restore: Callable[[], Awaitable[Any]] | None,
    arrived: Callable[[], Awaitable[T | None]] | None,
) -> T | None:
    """Settle a landing that raised.

    One whose answer was lost may have gone through, and then holds the
    name, where ``restore`` cannot put anything back: it is found by
    ``arrived`` and handed back to be finished, or, under a cancellation,
    taken back before the restore.

    Args:
        exc (BaseException): what the landing raised.
        take_back (Callable[[T], Awaitable[Any]]): what undoes a landing.
        restore (Callable[[], Awaitable[Any]] | None): what puts a set
            aside item back.
        arrived (Callable[[], Awaitable[T | None]] | None): what the
            landing made, when it went through.

    Returns:
        T | None: the landing to finish, None once both are put back.
    """
    found = None
    if arrived is not None and not _answered(exc):
        found = await _asked(arrived, "the landing went through")
    if found is not None:
        if isinstance(exc, Exception):
            return found
        landing = found
        await _quietly(lambda: take_back(landing), "take back the landing")
    if restore is not None:
        await _quietly(restore, "restore the destination")
    return None


async def _retire_failed(
    landed: T,
    take_back: Callable[[T], Awaitable[Any]],
    gone: Callable[[], Awaitable[bool]],
    restore: Callable[[], Awaitable[Any]] | None,
) -> bool:
    """Settle a retire that raised: undone only while what it named is
    still there. A delete whose answer was lost may have gone through, so
    a failed check keeps the landing: undoing it then would leave
    nothing at the name.

    Args:
        landed (T): what the landing answered.
        take_back (Callable[[T], Awaitable[Any]]): what undoes it.
        gone (Callable[[], Awaitable[bool]]): whether what the retire
            named is gone.
        restore (Callable[[], Awaitable[Any]] | None): what puts a set
            aside item back.

    Returns:
        bool: whether the retire went through after all.
    """
    went = await _asked(gone, "the retire went through")
    if went is None or went:
        return bool(went)
    await _quietly(lambda: take_back(landed), "take back the landing")
    if restore is not None:
        await _quietly(restore, "restore the destination")
    return False


async def land_then_retire(
    land: Callable[[], Awaitable[T]],
    take_back: Callable[[T], Awaitable[Any]],
    retire: Callable[[], Awaitable[Any]],
    gone: Callable[[], Awaitable[bool]],
    restore: Callable[[], Awaitable[Any]] | None = None,
    arrived: Callable[[], Awaitable[T | None]] | None = None,
) -> T:
    """Land an item on a name, then retire what held the name before.

    What held it was set aside (``restore`` puts it back) or, on a service
    that keeps two items of one name, left beside the landing. A refused
    landing restores it; one whose answer was lost but which went through
    (``arrived``) is finished. A failed retire takes the landing back and
    restores it, unless what it named is gone after all or that cannot be
    told: the replace then stands. The undo runs to its end under a
    cancellation, which reaches the caller after it.

    Args:
        land (Callable[[], Awaitable[T]]): the move or copy onto the name.
        take_back (Callable[[T], Awaitable[Any]]): what undoes a landing,
            held to the version it landed as.
        retire (Callable[[], Awaitable[Any]]): what deletes the item
            replaced.
        gone (Callable[[], Awaitable[bool]]): whether that item is gone.
        restore (Callable[[], Awaitable[Any]] | None): what puts a set
            aside item back, None when nothing was set aside.
        arrived (Callable[[], Awaitable[T | None]] | None): what the
            landing made when it went through, None when it did not or
            the service cannot tell it from another writer's.

    Returns:
        T: what ``land`` answered, or what ``arrived`` found.
    """
    try:
        landed = await land()
    except BaseException as exc:
        failure = exc
        found = await _undisturbed(
            lambda: _landing_failed(failure, take_back, restore, arrived)
        )
        if found is None:
            raise
        logger.debug("the landing went through after all: %s", exc)
        landed = found
    try:
        await retire()
    except BaseException as exc:
        went = await _undisturbed(
            lambda: _retire_failed(landed, take_back, gone, restore)
        )
        if went and isinstance(exc, Exception):
            return landed
        raise
    return landed
