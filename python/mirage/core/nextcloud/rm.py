import logging
from asyncio import sleep
from datetime import datetime
from email.utils import format_datetime, parsedate_to_datetime
from http import HTTPStatus
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

import httpx

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.constants import ATTEMPTS, FENCE, MTIME_PROPFIND
from mirage.core.nextcloud.dav import answered, dav_request, dav_url
from mirage.core.nextcloud.search.xml import dav
from mirage.core.nextcloud.set_attrs import mtime_patch
from mirage.errors.fs import eacces, ebusy, enoent, enotempty, fs_error
from mirage.errors.types import FsCondition
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


def failure(path: PathSpec, status: int) -> OSError:
    """The error for a status that ends a removal.

    Args:
        path (PathSpec): the collection.
        status (int): the HTTP status.
    """
    if status == HTTPStatus.NOT_FOUND:
        return enoent(path)
    if status == HTTPStatus.FORBIDDEN:
        return eacces(path)
    if status == HTTPStatus.LOCKED:
        return ebusy(path)
    return fs_error(path, FsCondition.EIO)


async def survey(
    accessor: NextcloudAccessor, path: PathSpec, depth: str
) -> tuple[bool, datetime, datetime]:
    """Whether a collection lists a child, when it last changed and the
    server's clock, from one PROPFIND.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the collection.
        depth (str): ``"1"`` to list its children, ``"0"`` for the
            collection alone.
    """
    url = dav_url(accessor, path, folder=True)
    response = await dav_request(
        accessor,
        "PROPFIND",
        url,
        headers={"Depth": depth, "Content-Type": "application/xml"},
        content=MTIME_PROPFIND,
    )
    if response.status_code != HTTPStatus.MULTI_STATUS:
        raise failure(path, response.status_code)
    own = unquote(urlsplit(url).path).rstrip("/")
    child = False
    modified = None
    for entry in ElementTree.fromstring(response.content).iter(
        dav("response")
    ):
        if unquote(entry.findtext(dav("href"), "")).rstrip("/") != own:
            child = True
        else:
            modified = answered(entry, "getlastmodified")
    try:
        return (
            child,
            parsedate_to_datetime(modified or ""),
            parsedate_to_datetime(response.headers["Date"]),
        )
    except (KeyError, ValueError) as error:
        raise fs_error(path, FsCondition.EIO) from error


async def retime(
    accessor: NextcloudAccessor,
    path: PathSpec,
    since: datetime,
    to: datetime,
) -> httpx.Response:
    """Set a collection's modified time to ``to`` unless it changed after
    ``since`` (412).

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the collection.
        since (datetime): the modified time the change is conditional on.
        to (datetime): the modified time to set.
    """
    return await dav_request(
        accessor,
        "PROPPATCH",
        dav_url(accessor, path, folder=True),
        headers={
            "Content-Type": "application/xml",
            "If-Unmodified-Since": format_datetime(since, True),
        },
        content=mtime_patch(int(to.timestamp())),
    )


async def settle(
    accessor: NextcloudAccessor,
    path: PathSpec,
    modified: datetime,
    now: datetime,
) -> bool:
    """Set a future-dated collection's modified time ``FENCE`` back from
    the server's clock, if nothing changed since the survey. Whether it
    set the time.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the collection.
        modified (datetime): its modified time at the last survey.
        now (datetime): the server's clock at the last survey.
    """
    response = await retime(accessor, path, modified, now - FENCE)
    return (
        response.status_code == HTTPStatus.MULTI_STATUS
        and answered(ElementTree.fromstring(response.content), "lastmodified")
        is not None
    )


async def remove(
    accessor: NextcloudAccessor, path: PathSpec, *, empty: bool
) -> None:
    """Delete a collection only as the survey before the DELETE saw it.

    WebDAV DELETE on a collection is recursive (RFC 4918 9.6.1), so a
    survey followed by a plain DELETE destroys what another client adds
    in between. Nextcloud never matches a collection's ETag, but every
    change below it (PUT, MKCOL, MOVE, COPY, DELETE, at any depth) sets
    the collection's modified time to the server's current second, and
    ``If-Unmodified-Since`` is honoured on a collection. So the DELETE
    carries the modified time the survey saw and the server refuses it
    with 412 once anything has changed. An empty-only removal then
    surveys again, since its survey lists the children; a subtree
    removal never listed what changed, so it keeps it and raises
    ENOTEMPTY.

    Times are whole seconds, so a change landing in the second the
    collection last changed would not move it. The fence needs the
    collection unchanged for ``FENCE`` by the server's clock, so a
    younger one is waited out; its time is never rewritten, since a
    rewrite racing another remover could hide a change. A future-dated
    collection never ages, so it is settled (:func:`settle`) and a
    removal that then fails puts its time back unless something changed
    it since. An arrival moves a future-dated time back to the clock,
    which ``If-Unmodified-Since`` cannot tell from no change, so a
    future-dated collection is fenced only against a single remover. A
    collection that keeps changing for ``ATTEMPTS`` surveys is busy.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the collection.
        empty (bool): refuse a collection holding a child with
            ENOTEMPTY, as rmdir does; otherwise take the whole subtree as
            the survey saw it.
    """
    backdated: tuple[datetime, datetime] | None = None
    try:
        for _ in range(ATTEMPTS):
            child, modified, now = await survey(
                accessor, path, "1" if empty else "0"
            )
            if child:
                raise enotempty(path)
            if modified > now:
                if await settle(accessor, path, modified, now):
                    backdated = (modified, now - FENCE)
                continue
            if now - modified < FENCE:
                await sleep((FENCE - (now - modified)).total_seconds())
                continue
            response = await dav_request(
                accessor,
                "DELETE",
                dav_url(accessor, path, folder=True),
                headers={
                    "If-Unmodified-Since": format_datetime(modified, True)
                },
            )
            if response.is_success:
                return
            if response.status_code != HTTPStatus.PRECONDITION_FAILED:
                raise failure(path, response.status_code)
            if not empty:
                raise enotempty(path)
        raise ebusy(path)
    except Exception:
        if backdated is not None:
            try:
                await retime(accessor, path, backdated[1], backdated[0])
            except Exception:
                logger.debug(
                    "Could not restore Nextcloud mtime %s", path, exc_info=True
                )
        raise


async def rm_r(accessor: NextcloudAccessor, path: PathSpec) -> None:
    """Remove a subtree in one DELETE that the server refuses once
    anything below has changed since the survey (:func:`remove`): what
    changed stays, and the call raises ENOTEMPTY.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the subtree's root.
    """
    await remove(accessor, path, empty=False)
