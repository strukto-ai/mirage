import pytest

from mirage.commands.builtin.generic.look import look
from mirage.io.types import materialize


async def _unused_read_bytes(path):
    raise AssertionError(f"look read {path} although stdin was given")


@pytest.mark.asyncio
async def test_look_fold_case():
    output, _ = await look(
        [],
        "AP",
        read_stream=_unused_read_bytes,
        stdin=b"apple\nApricot\nbanana\n",
        fold_case=True,
    )
    decoded = (await materialize(output)).decode()
    assert "apple" in decoded
    assert "Apricot" in decoded
