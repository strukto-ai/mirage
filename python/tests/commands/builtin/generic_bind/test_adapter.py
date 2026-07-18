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

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.generic_bind.adapter import CommandIO, Operation
from mirage.types import PathSpec
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES

TREE = {
    "/notion/pages": [
        "/notion/pages/Demo_page__uuid1",
        "/notion/pages/Roadmap__uuid2",
    ],
}


async def fake_readdir(accessor, path, index=None):
    key = path.virtual.rstrip("/") or "/"
    if key not in TREE:
        raise FileNotFoundError(key)
    return TREE[key]


def glob_spec(virtual: str, prefix: str) -> PathSpec:
    last_slash = virtual.rfind("/")
    return PathSpec(
        virtual=virtual,
        directory=virtual[:last_slash + 1],
        resource_path=virtual[len(prefix):].strip("/"),
        pattern=virtual[last_slash + 1:],
        resolved=False,
    )


def make_io(**kwargs) -> CommandIO:
    return CommandIO(readdir=fake_readdir,
                     read_bytes=fake_readdir,
                     read_stream=fake_readdir,
                     stat=fake_readdir,
                     is_mounted=lambda a: True,
                     **kwargs)


def test_command_io_default_glob_cap():
    assert make_io().max_glob_matches == DEFAULT_MAX_GLOB_MATCHES


@pytest.mark.asyncio
async def test_command_io_resolve_glob_binds_readdir():
    resolve = make_io().resolve_glob
    spec = glob_spec("/notion/pages/Demo*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert [p.virtual for p in result] == ["/notion/pages/Demo_page__uuid1"]


@pytest.mark.asyncio
async def test_command_io_resolve_glob_honors_cap():
    resolve = make_io(max_glob_matches=1).resolve_glob
    spec = glob_spec("/notion/pages/*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert len(result) == 1


def test_command_io_require_missing_op():
    io = make_io()
    with pytest.raises(NotImplementedError):
        io.require(Operation.WRITE)
    assert make_io(write=fake_readdir).require(Operation.WRITE) is fake_readdir
