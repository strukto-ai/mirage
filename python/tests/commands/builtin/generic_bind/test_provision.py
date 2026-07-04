# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import pytest

from mirage.commands.builtin.generic_bind.provision import (
    default_provision, make_copy_provision, make_file_read_provision,
    make_head_tail_provision, make_search_provision, make_transform_provision,
    metadata_provision, pure_provision, write_metadata_provision)
from mirage.commands.builtin.ram import COMMANDS as RAM_COMMANDS
from mirage.provision import Precision
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key

SIZES = {
    "/data/known.txt": 5,
    "/data/big.txt": 100,
    "/data/tree/a.txt": 7,
    "/data/tree/skip.parquet": 900,
    "/data/tree/sub/b.txt": 11,
}
DIRS = {"/data/tree", "/data/tree/sub"}
TREE = {
    "/data/tree":
    ["/data/tree/a.txt", "/data/tree/skip.parquet", "/data/tree/sub"],
    "/data/tree/sub": ["/data/tree/sub/b.txt"],
}


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=mount_key(path, "/data"),
                    virtual=path,
                    directory=path)


async def _stat(accessor, path, index=None) -> FileStat:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    if virtual in DIRS:
        return FileStat(name=virtual.rsplit("/", 1)[-1],
                        type=FileType.DIRECTORY)
    return FileStat(name=virtual.rsplit("/", 1)[-1],
                    size=SIZES.get(virtual),
                    type=FileType.TEXT)


async def _readdir(accessor, path, index=None) -> list[str]:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    return TREE[virtual]


async def _resolve_glob(accessor, paths, index=None) -> list[PathSpec]:
    out = []
    for p in paths:
        if p.pattern:
            out.extend(
                _spec(e) for e in TREE.get(p.directory.rstrip("/"), [])
                if e.endswith(p.pattern.lstrip("*")))
        else:
            out.append(p)
    return out


def _registered(name: str):
    for fn in RAM_COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == name and rc.filetype is None:
                return rc
    return None


def test_default_provision_families():
    assert default_provision("sort", _stat) is not None
    assert default_provision("grep", _stat) is not None
    assert default_provision("iconv", _stat) is not None
    assert default_provision("file", _stat) is not None
    assert default_provision("ls", _stat) is metadata_provision
    assert default_provision("stat", _stat) is metadata_provision
    assert default_provision("du", _stat) is metadata_provision
    assert default_provision("gzip", _stat) is not None
    assert default_provision("cp", _stat) is not None
    assert default_provision("rm", _stat) is write_metadata_provision
    assert default_provision("mv", _stat) is None
    assert default_provision("tee", _stat) is None


def test_factory_registers_default_provisions():
    for name in ("grep", "sort", "ls", "find", "md5", "cp", "gzip", "rm"):
        rc = _registered(name)
        assert rc is not None, name
        assert rc.provision_fn is not None, name
    rc = _registered("tee")
    assert rc is not None
    assert rc.provision_fn is None


@pytest.mark.asyncio
async def test_file_read_known_sizes_exact():
    provision = make_file_read_provision(_stat)
    result = await provision(
        None, [_spec("/data/known.txt"),
               _spec("/data/big.txt")],
        command="cat")
    assert result.precision == Precision.EXACT
    assert result.network_read_low == 105
    assert result.network_read_high == 105
    assert result.read_ops == 2


@pytest.mark.asyncio
async def test_file_read_missing_size_keeps_floor():
    provision = make_file_read_provision(_stat)
    result = await provision(
        None, [_spec("/data/known.txt"),
               _spec("/data/chat.jsonl")],
        command="cat")
    assert result.precision == Precision.UNKNOWN
    assert result.network_read_low == 5
    assert result.network_read_high == 5
    assert result.read_ops == 2


@pytest.mark.asyncio
async def test_head_tail_missing_size_keeps_known_ceiling():
    provision = make_head_tail_provision(_stat)
    result = await provision(
        None, [_spec("/data/known.txt"),
               _spec("/data/chat.jsonl")],
        command="head")
    assert result.precision == Precision.UNKNOWN
    assert result.network_read_low == 0
    assert result.network_read_high == 5
    assert result.read_ops == 2


@pytest.mark.asyncio
async def test_transform_keeps_read_floor_unknown_output():
    provision = make_transform_provision(_stat)
    result = await provision(None, [_spec("/data/known.txt")], command="gzip")
    assert result.precision == Precision.UNKNOWN
    assert result.network_read_low == 5
    assert result.network_read_high == 5
    assert result.read_ops == 1


@pytest.mark.asyncio
async def test_copy_brackets_read_and_write():
    provision = make_copy_provision(_stat)
    result = await provision(
        None, [_spec("/data/known.txt"),
               _spec("/data/dest.txt")],
        command="cp")
    assert result.precision == Precision.RANGE
    assert result.network_read_low == 0
    assert result.network_read_high == 5
    assert result.network_write_low == 0
    assert result.network_write_high == 5
    assert result.read_ops == 1


@pytest.mark.asyncio
async def test_write_metadata_zero_bytes_recursive_floors():
    result = await write_metadata_provision(None, [_spec("/data/known.txt")],
                                            command="rm")
    assert result.precision == Precision.EXACT
    assert result.network_read_high == 0
    assert result.read_ops == 1
    recursive = await write_metadata_provision(None,
                                               [_spec("/data/known.txt")],
                                               command="rm",
                                               r=True)
    assert recursive.precision == Precision.UNKNOWN


@pytest.mark.asyncio
async def test_pure_provision_zero_exact():
    result = await pure_provision(command="seq 3")
    assert result.precision == Precision.EXACT
    assert result.network_read_high == 0
    assert result.read_ops == 0


@pytest.mark.asyncio
async def test_file_read_expands_globs():
    provision = make_file_read_provision(_stat, _resolve_glob)
    pattern = PathSpec(virtual="/data/tree/*.txt",
                       directory="/data/tree/",
                       pattern="*.txt",
                       resource_path="tree/*.txt")
    result = await provision(None, [pattern], command="cat")
    assert result.precision == Precision.EXACT
    assert result.network_read_high == 7
    assert result.read_ops == 1


@pytest.mark.asyncio
async def test_file_read_unmatched_glob_unknown():
    provision = make_file_read_provision(_stat, _resolve_glob)
    pattern = PathSpec(virtual="/data/tree/*.nope",
                       directory="/data/tree/",
                       pattern="*.nope",
                       resource_path="tree/*.nope")
    result = await provision(None, [pattern], command="cat")
    assert result.precision == Precision.UNKNOWN
    assert result.network_read_high == 0


@pytest.mark.asyncio
async def test_search_recursive_walks_tree_exact():
    provision = make_search_provision(_stat, _resolve_glob, _readdir)
    result = await provision(None, [_spec("/data/tree")],
                             "x",
                             command="grep",
                             r=True)
    assert result.precision == Precision.EXACT
    assert result.network_read_high == 18
    assert result.read_ops == 2


@pytest.mark.asyncio
async def test_search_recursive_skips_columnar():
    provision = make_search_provision(_stat, _resolve_glob, _readdir)
    result = await provision(None, [_spec("/data/tree")],
                             "x",
                             command="grep",
                             r=True)
    assert result.network_read_high != 918


@pytest.mark.asyncio
async def test_search_without_readdir_keeps_floor():
    provision = make_search_provision(_stat, _resolve_glob)
    result = await provision(None, [_spec("/data/tree")],
                             "x",
                             command="grep",
                             r=True)
    assert result.precision == Precision.UNKNOWN


@pytest.mark.asyncio
async def test_search_recursive_cap_degrades(monkeypatch):
    monkeypatch.setattr(
        "mirage.commands.builtin.generic_bind.provision.MAX_PLAN_WALK", 2)
    provision = make_search_provision(_stat, _resolve_glob, _readdir)
    result = await provision(None, [_spec("/data/tree")],
                             "x",
                             command="grep",
                             r=True)
    assert result.precision == Precision.UNKNOWN
