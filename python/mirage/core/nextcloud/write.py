import logging

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.constants import (
    MAX_UPLOAD_CHUNKS,
    UPLOAD_CHUNK_SIZE,
)
from mirage.core.nextcloud.dav import dav_request, dav_url, uploads_url
from mirage.core.nextcloud.util import nextcloud_key
from mirage.errors.fs import enoent
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.ids import SystemIdSource

logger = logging.getLogger(__name__)


async def _chunked(
    accessor: NextcloudAccessor,
    path: PathSpec,
    spool: ByteSpool,
    uploads: str,
) -> None:
    """Upload a spooled file through Nextcloud's chunked upload: an upload
    folder, one PUT per chunk streamed from the spool, then a MOVE of its
    ``.file`` onto the destination. A failed upload's folder is deleted.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the destination.
        spool (ByteSpool): the file's bytes.
        uploads (str): the user's upload collection, from
            :func:`uploads_url`.
    """
    folder = f"{uploads}/mirage-{SystemIdSource().uuid7()}"
    target = {"Destination": dav_url(accessor, path)}
    headers = {**target, "OC-Total-Length": str(spool.size)}
    part = max(UPLOAD_CHUNK_SIZE, -(-spool.size // MAX_UPLOAD_CHUNKS))
    (await dav_request(accessor, "MKCOL", folder, target)).raise_for_status()
    try:
        for number, start in enumerate(range(0, spool.size, part), 1):
            size = min(part, spool.size - start)
            response = await dav_request(
                accessor,
                "PUT",
                f"{folder}/{number:05d}",
                {**headers, "Content-Length": str(size)},
                spool.stream(start, size),
            )
            response.raise_for_status()
        response = await dav_request(
            accessor, "MOVE", f"{folder}/.file", headers
        )
        response.raise_for_status()
    except BaseException:
        try:
            await dav_request(accessor, "DELETE", folder)
        except Exception:
            logger.debug(
                "Could not delete Nextcloud upload %s", folder, exc_info=True
            )
        raise


async def write(
    accessor: NextcloudAccessor,
    path: PathSpec,
    data: ByteSource,
) -> None:
    """Write a file, spooled first so its size picks the upload: past one
    chunk it goes up in chunks where the mount's URL names its user, else
    in one PUT through opendal. Either way the missing parents are made.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the file.
        data (ByteSource): its new content, consumed once.
    """
    key = nextcloud_key(path)
    op = accessor.operator()
    uploads = uploads_url(accessor)
    async with ByteSpool() as spool:
        await spool.fill(data)
        timer = start_op()
        try:
            if uploads is not None and spool.size > UPLOAD_CHUNK_SIZE:
                parent = key.rpartition("/")[0]
                if parent:
                    await op.create_dir(parent + "/")
                await _chunked(accessor, path, spool, uploads)
            else:
                await op.write(key, await spool.read(0, spool.size))
        except NotFound as exc:
            raise enoent(path) from exc
    record("write", path.virtual, "nextcloud", spool.size, timer)
