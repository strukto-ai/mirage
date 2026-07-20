import importlib

import pytest

from mirage.ops.dify.grep import grep

op_grep = importlib.import_module("mirage.ops.dify.grep")


async def grep_bytes(accessor, paths, pattern, index):
    return b"match"


@pytest.mark.asyncio
async def test_grep_op_delegates_to_core(monkeypatch, dify_accessor,
                                         dify_index, guide_path):
    monkeypatch.setattr(op_grep, "grep_bytes", grep_bytes)

    result = await grep(dify_accessor, [guide_path],
                        "pattern",
                        index=dify_index)

    assert result == b"match"
