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

from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.common import split_readable
from mirage.types import PathSpec


def _ops(missing: set[str]) -> CommandIO:

    async def stat(_accessor, path, _index):
        if path.virtual in missing:
            raise FileNotFoundError(path.virtual)
        return {"size": 0}

    async def unused(*_args):
        raise AssertionError("not used")

    return CommandIO(readdir=unused,
                     read_bytes=unused,
                     read_stream=unused,
                     stat=stat,
                     is_mounted=lambda _a: True)


@pytest.mark.asyncio
async def test_split_readable_keeps_order_and_reports_missing():
    paths = [
        PathSpec.from_str_path("/m1.txt"),
        PathSpec.from_str_path("/f.txt"),
        PathSpec.from_str_path("/m2.txt"),
    ]
    good, err = await split_readable(_ops({"/m1.txt", "/m2.txt"}), None, paths,
                                     None, "cat")
    assert [p.virtual for p in good] == ["/f.txt"]
    assert err == (b"cat: /m1.txt: No such file or directory\n"
                   b"cat: /m2.txt: No such file or directory\n")


@pytest.mark.asyncio
async def test_split_readable_all_good_no_stderr():
    paths = [PathSpec.from_str_path("/f.txt")]
    good, err = await split_readable(_ops(set()), None, paths, None, "head")
    assert [p.virtual for p in good] == ["/f.txt"]
    assert err == b""


@pytest.mark.asyncio
async def test_split_readable_propagates_non_fs_errors():

    async def stat(_accessor, _path, _index):
        raise RuntimeError("backend broke")

    async def unused(*_args):
        raise AssertionError("not used")

    ops = CommandIO(readdir=unused,
                    read_bytes=unused,
                    read_stream=unused,
                    stat=stat,
                    is_mounted=lambda _a: True)
    with pytest.raises(RuntimeError):
        await split_readable(ops, None, [PathSpec.from_str_path("/f.txt")],
                             None, "cat")
