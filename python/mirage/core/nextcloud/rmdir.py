from asyncio import sleep
from datetime import datetime, timedelta
from email.utils import format_datetime, parsedate_to_datetime
from http import HTTPStatus
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.dav import answered, dav_request, dav_url
from mirage.core.nextcloud.search.xml import dav
from mirage.core.nextcloud.set_attrs import mtime_patch
from mirage.errors.fs import eacces, ebusy, enoent, enotempty, fs_error
from mirage.errors.types import FsCondition
from mirage.types import PathSpec

SURVEY = (
    b'<?xml version="1.0" encoding="utf-8"?>'
    b'<d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/></d:prop>'
    b"</d:propfind>"
)
FENCE = timedelta(seconds=2)
ATTEMPTS = 4


def failure(path: PathSpec, status: int) -> OSError:
    """The error for a status that ends an rmdir.

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
    accessor: NextcloudAccessor, path: PathSpec
) -> tuple[bool, datetime, datetime]:
    """Whether a collection lists a child, when it last changed and the
    server's clock, from one Depth 1 PROPFIND.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the collection.
    """
    url = dav_url(accessor, path, folder=True)
    response = await dav_request(
        accessor,
        "PROPFIND",
        url,
        headers={"Depth": "1", "Content-Type": "application/xml"},
        content=SURVEY,
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
    if modified is None or "Date" not in response.headers:
        raise fs_error(path, FsCondition.EIO)
    return (
        child,
        parsedate_to_datetime(modified),
        parsedate_to_datetime(response.headers["Date"]),
    )


async def settle(
    accessor: NextcloudAccessor, path: PathSpec, now: datetime
) -> None:
    """Move a collection's modified time out of the fence: set it
    ``FENCE`` back from the server's clock, or wait ``FENCE`` out where
    the server will not set it.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the collection.
        now (datetime): the server's clock at the last survey.
    """
    response = await dav_request(
        accessor,
        "PROPPATCH",
        dav_url(accessor, path, folder=True),
        headers={"Content-Type": "application/xml"},
        content=mtime_patch(int((now - FENCE).timestamp())),
    )
    if (
        response.status_code != HTTPStatus.MULTI_STATUS
        or answered(ElementTree.fromstring(response.content), "lastmodified")
        is None
    ):
        await sleep(FENCE.total_seconds())


async def rmdir(accessor: NextcloudAccessor, path: PathSpec) -> None:
    """Remove an empty collection.

    WebDAV DELETE on a collection is recursive (RFC 4918 9.6.1), so a
    listing followed by a plain DELETE destroys a child another client
    adds in between. Nextcloud never matches a collection's ETag, but
    every child that arrives (PUT, MKCOL, MOVE, COPY, at any depth)
    sets the collection's modified time to the server's current
    second, and ``If-Unmodified-Since`` is honoured on a collection. So
    the DELETE carries the modified time the listing saw and the server
    refuses it with 412 once anything has arrived; the listing is then
    taken again.

    Times are whole seconds, so a child landing in the second the
    collection last changed would not move it. The fence needs the
    collection unchanged for ``FENCE`` by the server's clock; a younger
    or future-dated one is settled first (:func:`settle`). A collection
    that keeps changing for ``ATTEMPTS`` listings is busy.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): collection to remove.
    """
    for _ in range(ATTEMPTS):
        child, modified, now = await survey(accessor, path)
        if child:
            raise enotempty(path)
        if now - modified < FENCE:
            await settle(accessor, path, now)
            continue
        response = await dav_request(
            accessor,
            "DELETE",
            dav_url(accessor, path, folder=True),
            headers={"If-Unmodified-Since": format_datetime(modified, True)},
        )
        if response.is_success:
            return
        if response.status_code != HTTPStatus.PRECONDITION_FAILED:
            raise failure(path, response.status_code)
    raise ebusy(path)
