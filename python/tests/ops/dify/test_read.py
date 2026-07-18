from types import SimpleNamespace

import pytest

from mirage.core.dify import read as core_read
from mirage.ops.dify import OPS


def _op(name: str):
    return next(o.fn for o in OPS if o.name == name and o.filetype is None)


read = _op("read")


async def resolve_file(accessor, path, index):
    return SimpleNamespace(is_dir=False, entry=SimpleNamespace(id="doc-1"))


async def get_segments(config, document_id):
    return [{"content": "first"}, {"content": "second"}]


@pytest.mark.asyncio
async def test_read_op_delegates_to_core(monkeypatch, dify_accessor,
                                         dify_index, guide_path):
    monkeypatch.setattr(core_read, "resolve_path", resolve_file)
    monkeypatch.setattr(core_read, "get_document_segments", get_segments)

    result = await read(dify_accessor, guide_path, index=dify_index)

    assert result == b"first\nsecond"
