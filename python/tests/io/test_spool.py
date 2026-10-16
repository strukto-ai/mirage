import pytest

from mirage.io.spool import ByteSpool
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
