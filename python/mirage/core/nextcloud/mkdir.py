from opendal import AsyncOperator
from opendal.exceptions import NotFound, Unexpected
from opendal.types import EntryMode

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.nextcloud.util import nextcloud_key
from mirage.types import PathSpec
from mirage.utils.errors import eexist, enotdir
from mirage.utils.key_prefix import mounted_path


async def _file_level(op: AsyncOperator, key: str) -> str | None:
    """The first level of ``key`` that is a file, None when none is.

    Args:
        op (AsyncOperator): the mount's operator.
        key (str): the collection's key, without a trailing slash.
    """
    level = ""
    for part in key.split("/"):
        level = f"{level}/{part}" if level else part
        try:
            md = await op.stat(level)
        except NotFound:
            return None
        if md.mode != EntryMode.Dir:
            return level
    return None


async def mkdir(
    accessor: NextcloudAccessor, path: PathSpec, parents: bool = False
) -> None:
    """Create a collection; opendal creates missing parents either way.

    ``parents`` only picks the path a refusal names, because
    ``create_dir`` is MKCOL over every missing level whatever it says.
    That is also why the ancestor invalidation is unconditional: a bare
    ``mkdir a/b/c`` materializes a whole chain here, and gating the walk
    on ``parents`` (as the backends whose mkdir really does create one
    level correctly do) left every ancestor above the parent serving a
    cached listing that hid the new levels until the index TTL expired.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): collection to create.
        parents (bool): opendal always creates parents; with it, a file
            in the way is named rather than the operand.
    """
    key = nextcloud_key(path).rstrip("/")
    op = accessor.operator()
    # MKCOL under a file is a 409 opendal leaves unnamed, and opendal reads
    # MKCOL's 405 on a taken name as done, a file holding the name
    # included: look the levels up to tell ENOTDIR from EEXIST.
    try:
        await op.create_dir(key + "/")
    except Unexpected as exc:
        level = await _file_level(op, key)
        if level is None:
            raise
        if level == key:
            raise eexist(path) from exc
        # mkdir(2) blames the operand; the walk `-p` makes stops at the
        # file and names it.
        raise enotdir(
            mounted_path(path, "/" + level) if parents else path
        ) from exc
    await invalidate_after_write(path)
    await invalidate_ancestors(path)
    try:
        md = await op.stat(key)
    except NotFound:
        md = None
    if md is not None and md.mode != EntryMode.Dir:
        raise eexist(path)
