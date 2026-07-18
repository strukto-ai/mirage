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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.generic_bind import CommandIO
from mirage.ops.generic import make_generic_ops
from mirage.ops.registry import OpsRegistry
from mirage.types import PathSpec

PATH = PathSpec.from_str_path("/x/a.txt", "a.txt")


def make_table(**kwargs) -> CommandIO:
    return CommandIO(readdir=AsyncMock(return_value=["/x/a.txt"]),
                     read_bytes=AsyncMock(return_value=b"data"),
                     read_stream=AsyncMock(),
                     stat=AsyncMock(),
                     is_mounted=lambda a: True,
                     **kwargs)


def rows(ops) -> set:
    return {(o.name, o.resource, o.filetype, o.write) for o in ops}


def test_read_only_table_emits_trio():
    ops = make_generic_ops("x", make_table())
    assert rows(ops) == {
        ("read", "x", None, False),
        ("readdir", "x", None, False),
        ("stat", "x", None, False),
    }


def test_full_table_emits_mutations():
    table = make_table(write=AsyncMock(),
                       mkdir=AsyncMock(),
                       unlink=AsyncMock(),
                       rmdir=AsyncMock(),
                       rename=AsyncMock(),
                       create=AsyncMock(),
                       truncate=AsyncMock(),
                       append=AsyncMock(),
                       set_attrs=AsyncMock())
    names = {(o.name, o.write) for o in make_generic_ops("x", table)}
    assert names == {
        ("read", False),
        ("readdir", False),
        ("stat", False),
        ("write", True),
        ("mkdir", True),
        ("unlink", True),
        ("rmdir", True),
        ("rename", True),
        ("create", True),
        ("truncate", True),
        ("append", True),
        ("setattr", True),
    }


def test_multi_resource_fan_out():
    ops = make_generic_ops(["a", "b"], make_table())
    assert {o.resource for o in ops} == {"a", "b"}
    assert len(ops) == 6


def test_overrides_skip_names():
    ops = make_generic_ops("x", make_table(), overrides={"readdir"})
    assert {o.name for o in ops} == {"read", "stat"}


def test_filetype_read_emits_cat_ops():
    ops = make_generic_ops("x", make_table(), filetype_read=True)
    filetypes = {o.filetype for o in ops if o.filetype}
    # pyarrow/h5py are installed in the dev env; formats whose dep is
    # missing are skipped, so assert subset rather than equality.
    assert filetypes <= {".parquet", ".feather", ".orc", ".hdf5"}
    assert all(o.name == "read" for o in ops if o.filetype)


@pytest.mark.asyncio
async def test_read_wrapper_forwards_index():
    table = make_table()
    ops = make_generic_ops("x", table)
    read = next(o for o in ops if o.name == "read")
    acc = NOOPAccessor()
    result = await read.fn(acc, PATH, index=None)
    assert result == b"data"
    table.read_bytes.assert_awaited_once_with(acc, PATH, None)


@pytest.mark.asyncio
async def test_emulated_truncate_pads_and_cuts():
    table = make_table(write=AsyncMock())
    ops = make_generic_ops("x", table, emulate_truncate=True)
    truncate = next(o for o in ops if o.name == "truncate")
    await truncate.fn(NOOPAccessor(), PATH, 6)
    written = table.write.await_args.args[2]
    assert written == b"data\0\0"
    await truncate.fn(NOOPAccessor(), PATH, 2)
    assert table.write.await_args.args[2] == b"da"


@pytest.mark.asyncio
async def test_emulated_truncate_missing_file_pads_zeros():
    table = make_table(write=AsyncMock())
    table.read_bytes.side_effect = FileNotFoundError(PATH.virtual)
    ops = make_generic_ops("x", table, emulate_truncate=True)
    truncate = next(o for o in ops if o.name == "truncate")
    await truncate.fn(NOOPAccessor(), PATH, 3)
    assert table.write.await_args.args[2] == b"\0\0\0"


def test_emulated_truncate_requires_write():
    with pytest.raises(ValueError):
        make_generic_ops("x", make_table(), emulate_truncate=True)


@pytest.mark.asyncio
async def test_mkdir_parents_knob():
    table = make_table(mkdir=AsyncMock())
    ops = make_generic_ops("x", table, mkdir_parents=True)
    mkdir = next(o for o in ops if o.name == "mkdir")
    acc = NOOPAccessor()
    await mkdir.fn(acc, PATH)
    table.mkdir.assert_awaited_once_with(acc, PATH, parents=True)


def test_native_truncate_wins_over_emulation():
    table = make_table(write=AsyncMock(), truncate=AsyncMock())
    ops = make_generic_ops("x", table, emulate_truncate=True)
    truncates = [o for o in ops if o.name == "truncate"]
    assert len(truncates) == 1


def test_registry_resolution():
    registry = OpsRegistry()
    for ro in make_generic_ops("x", make_table()):
        registry.register(ro)
    assert registry.resolve("read", "x") is not None
