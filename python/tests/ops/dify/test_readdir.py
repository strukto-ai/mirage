from types import SimpleNamespace

import pytest

from mirage.core.dify import readdir as core_readdir
from mirage.ops.dify import OPS


def _op(name: str):
    return next(o.fn for o in OPS if o.name == name and o.filetype is None)


readdir = _op("readdir")


async def resolve_dir(accessor, path, index):
    return SimpleNamespace(is_dir=True, virtual_key="/knowledge/guides")


class ListingIndex:

    async def list_dir(self, virtual_key):
        return SimpleNamespace(entries=[
            f"{virtual_key}/a",
            f"{virtual_key}/b",
        ])


@pytest.mark.asyncio
async def test_readdir_op_delegates_to_core(monkeypatch, dify_accessor,
                                            guide_path):
    monkeypatch.setattr(core_readdir, "resolve_path", resolve_dir)

    result = await readdir(dify_accessor, guide_path, index=ListingIndex())

    assert result == [
        "/knowledge/guides/a",
        "/knowledge/guides/b",
    ]
