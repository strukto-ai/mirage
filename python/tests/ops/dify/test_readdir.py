import importlib

import pytest

from mirage.ops.dify.readdir import readdir

op_readdir = importlib.import_module("mirage.ops.dify.readdir")


async def core_readdir_result(accessor, path, index):
    return [path.child("a"), path.child("b")]


@pytest.mark.asyncio
async def test_readdir_op_delegates_to_core(monkeypatch, dify_accessor,
                                            dify_index, guide_path):
    monkeypatch.setattr(op_readdir, "core_readdir", core_readdir_result)

    result = await readdir(dify_accessor, guide_path, index=dify_index)

    assert result == [
        "/knowledge/guides/quickstart/a",
        "/knowledge/guides/quickstart/b",
    ]
