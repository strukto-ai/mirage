import importlib

import pytest

from mirage.ops.dify.stat import stat

from .conftest import sample_stat

op_stat = importlib.import_module("mirage.ops.dify.stat")


async def core_stat_result(accessor, path, index):
    return sample_stat()


@pytest.mark.asyncio
async def test_stat_op_delegates_to_core(monkeypatch, dify_accessor,
                                         dify_index, guide_path):
    monkeypatch.setattr(op_stat, "core_stat", core_stat_result)

    result = await stat(dify_accessor, guide_path, index=dify_index)

    assert result == sample_stat()
