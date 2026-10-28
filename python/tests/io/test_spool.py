import errno

import pytest

from mirage.io.spool import ByteSlice, ByteSpool
from mirage.io.types import materialize


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [0, 13, 2000000])
async def test_spill_replay_and_windows(limit):
    expected = bytes(range(256)) * 1400
    async with ByteSpool(limit) as spool:
        for start in range(0, len(expected), 777):
            await spool.append(expected[start : start + 777])
        assert spool.size == len(expected)
        assert await spool.read(262141, 11) == expected[262141:262152]
        assert await spool.read(0, 9) == expected[:9]
        assert await materialize(spool.stream()) == expected
        assert (
            await materialize(spool.stream(70000, 5000))
            == expected[70000:75000]
        )
        assert await spool.read(len(expected), 8) == b""
    with pytest.raises(ValueError, match="closed"):
        await spool.read(0, 1)
    await spool.close()


@pytest.mark.asyncio
async def test_fill_closes_source_when_spill_fails(monkeypatch):
    closed = []

    async def source():
        try:
            yield b"content"
            raise AssertionError("must not pull again")
        finally:
            closed.append(True)

    def fail(**kwargs):
        raise OSError("scratch full")

    monkeypatch.setattr("mirage.io.spool.tempfile.TemporaryFile", fail)
    async with ByteSpool(0) as spool:
        with pytest.raises(OSError, match="scratch full"):
            await spool.fill(source())
    assert closed == [True]


@pytest.mark.asyncio
async def test_a_spool_that_lost_a_write_fails_every_call_after(monkeypatch):
    def fail(**kwargs):
        raise OSError("scratch full")

    async with ByteSpool(4) as spool:
        await spool.append(b"kept")
        monkeypatch.setattr("mirage.io.spool.tempfile.TemporaryFile", fail)
        with pytest.raises(OSError, match="scratch full"):
            await spool.append(b"lost")
        monkeypatch.undo()
        with pytest.raises(OSError) as lost:
            await spool.append(b"more")
        assert lost.value.errno == errno.EIO
        with pytest.raises(OSError):
            await spool.read(0, 4)


@pytest.mark.asyncio
async def test_a_byte_slice_sizes_and_slices_as_its_window():
    async with ByteSpool() as spool:
        await spool.append(b"0123456789")
        window = ByteSlice(spool, 2, 6)
        head, tail = window[:2], window[4:]
        assert len(window) == 6
        assert (head.offset, len(head)) == (2, 2)
        assert (tail.offset, len(tail)) == (6, 2)
        assert len(window[10:]) == 0
        assert await materialize(tail.stream()) == b"67"
