import pytest

from mirage.core.databricks_volume.read import read
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.databricks_volume import FILES, FILES_PREFIX

LATEST = PathSpec.from_str_path(
    "/volume/reports/latest.md",
    mount_key("/volume/reports/latest.md", "/volume"),
)


@pytest.mark.asyncio
async def test_read_file(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/reports/latest.md", b"hello")
    await volume.run.record_requests()
    result = await read(accessor, LATEST)
    assert result == b"hello"
    assert await volume.asked("GET", FILES) == [
        f"{remote_root}/reports/latest.md"
    ]


@pytest.mark.asyncio
async def test_read_file_not_found(accessor):
    path = PathSpec.from_str_path(
        "/volume/missing.md", mount_key("/volume/missing.md", "/volume")
    )
    with pytest.raises(FileNotFoundError):
        await read(accessor, path)


@pytest.mark.asyncio
async def test_read_slice(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/reports/latest.md", b"abcdef")
    result = await read(accessor, LATEST, offset=1, size=3)
    assert result == b"bcd"


@pytest.mark.asyncio
async def test_read_slice_uses_databricks_range_request(
    accessor,
    volume,
    remote_root,
):
    await volume.put(f"{remote_root}/reports/latest.md", b"abcdef")
    await volume.run.record_requests("range")

    result = await read(accessor, LATEST, offset=1, size=3)

    assert result == b"bcd"
    assert await volume.asked("GET", FILES) == [
        f"{remote_root}/reports/latest.md"
    ]
    assert await volume.run.headers("GET", FILES) == [{"range": "bytes=1-3"}]


@pytest.mark.asyncio
async def test_read_from_offset_uses_open_ended_range(
    accessor,
    volume,
    remote_root,
):
    await volume.put(f"{remote_root}/reports/latest.md", b"abcdef")
    await volume.run.record_requests("range")

    result = await read(accessor, LATEST, offset=3)

    assert result == b"def"
    assert await volume.asked("GET", FILES) == [
        f"{remote_root}/reports/latest.md"
    ]
    assert await volume.run.headers("GET", FILES) == [{"range": "bytes=3-"}]


@pytest.mark.asyncio
async def test_read_zero_size_returns_empty_without_network(
    accessor,
    volume,
    remote_root,
):
    await volume.put(f"{remote_root}/reports/latest.md", b"abcdef")
    await volume.run.record_requests()

    result = await read(accessor, LATEST, size=0)

    assert result == b""
    assert await volume.run.requests() == []


@pytest.mark.asyncio
async def test_a_gateway_that_ignores_the_range_is_sliced_locally(
    accessor, volume, remote_root
):
    """A Range is a request, not an instruction: the Files API may sit
    behind a gateway that answers with the whole object. Before this was
    handled the caller got every byte for what it asked to be a window."""
    remote = f"{remote_root}/reports/latest.md"
    await volume.put(remote, b"abcdef")
    await volume.run.answer_next(
        "GET", FILES, 200, b"abcdef", path=f"{FILES_PREFIX}{remote}"
    )

    result = await read(accessor, LATEST, offset=1, size=3)

    assert result == b"bcd"
