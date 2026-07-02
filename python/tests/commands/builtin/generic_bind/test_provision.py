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
    default_provision, make_file_read_provision, make_head_tail_provision,
    metadata_provision)
from mirage.commands.builtin.ram import COMMANDS as RAM_COMMANDS
from mirage.provision import Precision
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key

SIZES = {"/data/known.txt": 5, "/data/big.txt": 100}


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=mount_key(path, "/data"),
                    virtual=path,
                    directory=path)


async def _stat(accessor, path, index=None) -> FileStat:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    return FileStat(name=virtual.rsplit("/", 1)[-1],
                    size=SIZES.get(virtual),
                    type=FileType.TEXT)


def _registered(name: str):
    for fn in RAM_COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == name and rc.filetype is None:
                return rc
    return None


def test_default_provision_families():
    assert default_provision("sort", _stat) is not None
    assert default_provision("grep", _stat) is not None
    assert default_provision("ls", _stat) is metadata_provision
    assert default_provision("cp", _stat) is None
    assert default_provision("tee", _stat) is None


def test_factory_registers_default_provisions():
    for name in ("grep", "sort", "ls", "find", "md5"):
        rc = _registered(name)
        assert rc is not None, name
        assert rc.provision_fn is not None, name
    rc = _registered("cp")
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
