from datetime import datetime
from http import HTTPStatus
from xml.etree import ElementTree

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.dav import answered, dav_request, dav_url
from mirage.errors.fs import enoent
from mirage.types import PathSpec


def mtime_patch(seconds: int) -> bytes:
    """The PROPPATCH body that sets a node's modified time.

    Args:
        seconds (int): the time, in whole seconds since the epoch.
    """
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop>'
        f"<d:lastmodified>{seconds}</d:lastmodified>"
        "</d:prop></d:set></d:propertyupdate>"
    ).encode()


async def set_attrs(
    accessor: NextcloudAccessor,
    path: PathSpec,
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
    atime: str | None = None,
    mtime: str | None = None,
) -> dict[str, int | str]:
    """Store a modified time on the node, and return the fields
    Nextcloud does not keep: permission bits, ownership and the access
    time land in the namespace's overlay, and so does the modified time
    on a server that will not set it.

    Nextcloud keeps whole seconds, so a fraction is dropped.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the file or folder.
        mode (int | None): permission bits.
        uid (int | str | None): owner.
        gid (int | str | None): group.
        atime (str | None): ISO access time.
        mtime (str | None): ISO modification time.
    """
    residual: dict[str, int | str] = {}
    for key, value in (("mode", mode), ("uid", uid), ("gid", gid)):
        if value is not None:
            residual[key] = value
    if atime is not None:
        residual["atime"] = atime
    if mtime is None:
        return residual
    seconds = int(datetime.fromisoformat(mtime).timestamp())
    response = await dav_request(
        accessor,
        "PROPPATCH",
        dav_url(accessor, path),
        headers={"Content-Type": "application/xml"},
        content=mtime_patch(seconds),
    )
    if response.status_code == HTTPStatus.NOT_FOUND:
        raise enoent(path)
    if response.status_code != HTTPStatus.MULTI_STATUS or (
        answered(ElementTree.fromstring(response.content), "lastmodified")
        is None
    ):
        residual["mtime"] = mtime
    return residual
