import importlib

import pytest

from mirage.ops.dify.read import read

op_read = importlib.import_module("mirage.ops.dify.read")


async def read_bytes(accessor, path, index):
    return path.virtual.encode()


@pytest.mark.asyncio
async def test_read_op_delegates_to_core(monkeypatch, dify_accessor,
                                         dify_index, guide_path):
    monkeypatch.setattr(op_read, "read_bytes", read_bytes)

    result = await read(dify_accessor, guide_path, index=dify_index)

    assert result == guide_path.virtual.encode()
