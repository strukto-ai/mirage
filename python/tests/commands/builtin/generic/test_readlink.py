import pytest

from mirage.commands.builtin.generic.readlink import readlink_generic
from mirage.commands.config import Context
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(original: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(original, prefix),
        virtual=original,
        directory=original,
        resolved=True,
    )


@pytest.mark.asyncio
async def test_readlink_simple():
    out, _ = await readlink_generic([_spec("/a/b")], [], Context())
    assert out == b"/a/b\n"


@pytest.mark.asyncio
async def test_readlink_with_prefix():
    out, _ = await readlink_generic(
        [_spec("/mnt/b", prefix="/mnt")], [], Context()
    )
    assert out == b"/mnt/b\n"


@pytest.mark.asyncio
async def test_readlink_normalize_with_f():
    out, _ = await readlink_generic(
        [_spec("/a/./b")], [], Context(flags={"canonicalize": True})
    )
    assert out == b"/a/b\n"


@pytest.mark.asyncio
async def test_readlink_missing_operand():
    with pytest.raises(ValueError, match="missing operand"):
        await readlink_generic([], [], Context())
