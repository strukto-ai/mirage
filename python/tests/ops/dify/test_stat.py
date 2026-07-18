from types import SimpleNamespace

import pytest

from mirage.core.dify import stat as core_stat
from mirage.ops.dify import OPS
from mirage.types import FileType


def _op(name: str):
    return next(o.fn for o in OPS if o.name == name and o.filetype is None)


stat = _op("stat")


async def resolve_file(accessor, path, index):
    return SimpleNamespace(is_dir=False,
                           entry=SimpleNamespace(id="doc-1",
                                                 name="quickstart",
                                                 size=12,
                                                 extra={}))


async def get_detail(config, document_id):
    return {"updated_at": 1700000000}


@pytest.mark.asyncio
async def test_stat_op_delegates_to_core(monkeypatch, dify_accessor,
                                         dify_index, guide_path):
    monkeypatch.setattr(core_stat, "resolve_path", resolve_file)
    monkeypatch.setattr(core_stat, "get_document_detail", get_detail)

    result = await stat(dify_accessor, guide_path, index=dify_index)

    assert result.name == "quickstart"
    assert result.type == FileType.TEXT
    assert result.size is None
    assert result.extra["source_size"] == 12
