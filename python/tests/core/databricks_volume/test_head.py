import pytest

from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.databricks_volume.head import head
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


async def collect_bytes(source) -> bytes:
    return b"".join([chunk async for chunk in source])


@pytest.mark.asyncio
async def test_head_bytes_mode_uses_single_small_range_request(
    accessor,
    files,
    remote_root,
):
    files.downloads[f"{remote_root}/reports/latest.md"] = b"abcdef"
    path = PathSpec.from_str_path(
        "/volume/reports/latest.md",
        mount_key("/volume/reports/latest.md", "/volume"))

    source, _io = await head(accessor, [path], index=NULL_INDEX, c="3")

    assert await collect_bytes(source) == b"abc"
    assert files.download_calls == []
    assert len(accessor.client.api_client.do_calls) == 1
    assert accessor.client.api_client.do_calls[0]["headers"]["Range"] == (
        "bytes=0-2")
