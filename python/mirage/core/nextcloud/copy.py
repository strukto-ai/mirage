from http import HTTPStatus

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write, invalidate_subtree
from mirage.core.nextcloud.dav import dav_request, dav_url
from mirage.core.nextcloud.util import nextcloud_key
from mirage.errors.fs import eacces, eexist, enoent
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
    await invalidate_after_write(dst)


async def dir_copy(
    accessor: NextcloudAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """Copy a folder tree onto a fresh name in one WebDAV COPY.

    ``cp -r`` asks this only when nothing holds ``dst``, so the copy
    goes with ``Overwrite: F`` and a taken name is refused, never
    replaced.

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
    if response.status_code == HTTPStatus.NOT_FOUND:
        raise enoent(src)
    if response.status_code == HTTPStatus.CONFLICT:
        raise enoent(dst)
    if response.status_code == HTTPStatus.PRECONDITION_FAILED:
        raise eexist(dst)
    if response.status_code == HTTPStatus.FORBIDDEN:
        raise eacces(dst)
    response.raise_for_status()
    record("copy_prefix", dst.virtual, "nextcloud", 0, timer)
    lift_lost(dst, upto, subtree=True)
    await invalidate_subtree(dst)
