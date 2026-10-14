from http import HTTPStatus
from xml.etree import ElementTree

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.dav import dav_request, dav_url
from mirage.core.nextcloud.search.xml import dav
from mirage.core.nextcloud.util import nextcloud_key
from mirage.errors.fs import eacces, eexist, enoent, fs_error
from mirage.errors.types import FsCondition
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec


async def copy(
    accessor: NextcloudAccessor, src: PathSpec, dst: PathSpec
) -> None:
    src_key = nextcloud_key(src)
    dst_key = nextcloud_key(dst)
    op = accessor.operator()
    try:
        await op.copy(src_key, dst_key)
    except NotFound as exc:
        raise enoent(src) from exc


def failed_status(content: bytes) -> int:
    """The first failure a COPY's multistatus reports for a member of
    the tree, 500 when it names none.

    Args:
        content (bytes): the 207 multistatus body.
    """
    root = ElementTree.fromstring(content)
    for status in root.iter(dav("status")):
        parts = (status.text or "").split()
        if len(parts) >= 2 and parts[1].isdigit() and int(parts[1]) >= 300:
            return int(parts[1])
    return HTTPStatus.INTERNAL_SERVER_ERROR


async def dir_copy(
    accessor: NextcloudAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """Copy a folder tree onto a fresh name in one WebDAV COPY.

    ``cp -r`` asks this only when nothing holds ``dst``, so the copy
    goes with ``Overwrite: F`` and a taken name is refused, never
    replaced. A multistatus answer is a tree copied in part, refused
    for its first failed member.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        src (PathSpec): the folder.
        dst (PathSpec): the copy.
    """
    upto = lost_count()
    timer = start_op()
    response = await dav_request(
        accessor,
        "COPY",
        dav_url(accessor, src, folder=True),
        headers={
            "Destination": dav_url(accessor, dst, folder=True),
            "Depth": "infinity",
            "Overwrite": "F",
        },
    )
    status = response.status_code
    if status == HTTPStatus.MULTI_STATUS:
        status = failed_status(response.content)
    if status == HTTPStatus.NOT_FOUND:
        raise enoent(src)
    if status == HTTPStatus.CONFLICT:
        raise enoent(dst)
    if status == HTTPStatus.PRECONDITION_FAILED:
        raise eexist(dst)
    if status in (HTTPStatus.FORBIDDEN, HTTPStatus.LOCKED):
        raise eacces(dst)
    if response.status_code == HTTPStatus.MULTI_STATUS:
        raise fs_error(dst, FsCondition.EIO)
    response.raise_for_status()
    record("copy_prefix", dst.virtual, "nextcloud", 0, timer)
    lift_lost(dst, upto, subtree=True)
