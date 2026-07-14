from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX
from mirage.core.sharepoint.read import read_bytes
from mirage.core.sharepoint.write import write_bytes
from mirage.types import PathSpec


async def truncate(accessor: SharePointAccessor, path: PathSpec,
                   length: int) -> None:
    try:
        data = await read_bytes(accessor, path, index=NULL_INDEX)
    except FileNotFoundError:
        data = b""
    if length <= len(data):
        new = data[:length]
    else:
        new = data + b"\x00" * (length - len(data))
    await write_bytes(accessor, path, new)
