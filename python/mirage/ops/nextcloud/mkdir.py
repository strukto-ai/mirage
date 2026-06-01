from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.mkdir import mkdir as mkdir_impl
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("mkdir", resource="nextcloud", write=True)
async def mkdir(accessor: NextcloudAccessor, path: PathSpec, **kwargs) -> None:
    await mkdir_impl(accessor, path)
