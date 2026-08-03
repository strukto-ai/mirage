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

from mirage.commands.registry import RegisteredCommand, command
from mirage.commands.spec import SPECS, CommandSpec, Operand, ValueType
from mirage.io.types import IOResult


def test_registered_command_dataclass():

    async def dummy(backend, paths, *texts, stdin=None, **flags):
        return b"ok", IOResult()

    rc = RegisteredCommand(
        name="cat",
        spec=SPECS["cat"],
        resource="s3",
        filetype=None,
        fn=dummy,
    )
    assert rc.name == "cat"
    assert rc.resource == "s3"
    assert rc.filetype is None
    assert rc.fn is dummy


def test_command_decorator_attaches_metadata():

    @command("myls",
             resource="s3",
             spec=CommandSpec(rest=Operand(type="path")))
    async def my_ls(backend, paths, *texts, stdin=None, **flags):
        return b"ok", IOResult()

    assert hasattr(my_ls, "_registered_commands")
    assert len(my_ls._registered_commands) == 1
    rc = my_ls._registered_commands[0]
    assert rc.name == "myls"
    assert rc.resource == "s3"
    assert rc.filetype is None


def test_command_decorator_stacking():

    @command("cat", resource="s3", spec=SPECS["cat"])
    @command("cat", resource="ram", spec=SPECS["cat"])
    async def cat_impl(backend, paths, *texts, stdin=None, **flags):
        return b"ok", IOResult()

    assert len(cat_impl._registered_commands) == 2
    backends = {rc.resource for rc in cat_impl._registered_commands}
    assert backends == {"s3", "ram"}


def test_command_decorator_with_filetype():

    @command("cat",
             resource="s3",
             filetype=".avro",
             spec=CommandSpec(rest=Operand(type="path")))
    async def cat_avro(backend, paths, *texts, stdin=None, **flags):
        return b"ok", IOResult()

    rc = cat_avro._registered_commands[0]
    assert rc.filetype == ".avro"
    assert rc.resource == "s3"


def test_command_decorator_requires_spec():
    with pytest.raises(TypeError):

        @command("myls", resource="s3")
        async def my_ls(backend, paths, *texts, stdin=None, **flags):
            return b"ok", IOResult()
