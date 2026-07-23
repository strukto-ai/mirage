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

import asyncio

from mirage.commands.config import RegisteredCommand, command, cross_command
from mirage.commands.spec import CommandSpec, Operand, OperandKind
from mirage.version import __version__


class TestRegisteredCommand:

    def test_basic_fields(self):
        rc = RegisteredCommand(
            name="cat",
            spec=CommandSpec(rest=Operand(kind=OperandKind.PATH)),
            resource="ram",
            filetype=None,
            fn=lambda: None,
        )
        assert rc.name == "cat"
        assert rc.resource == "ram"
        assert rc.filetype is None
        assert rc.provision_fn is None

    def test_with_filetype(self):
        rc = RegisteredCommand(
            name="grep",
            spec=CommandSpec(),
            resource="s3",
            filetype=".parquet",
            fn=lambda: None,
        )
        assert rc.filetype == ".parquet"


class TestCommandDecorator:

    def test_decorator_attaches_registered_commands(self):
        spec = CommandSpec(rest=Operand(kind=OperandKind.PATH))

        @command("mytest", resource="ram", spec=spec)
        async def my_fn(backend, paths, *texts, **kw):
            pass

        assert hasattr(my_fn, "_registered_commands")
        assert len(my_fn._registered_commands) == 1
        rc = my_fn._registered_commands[0]
        assert rc.name == "mytest"
        assert rc.resource == "ram"

    def test_decorator_with_provision(self):
        spec = CommandSpec()

        async def my_provision(*a, **kw):
            pass

        @command("mytest", resource="ram", spec=spec, provision=my_provision)
        async def my_fn(backend, paths, *texts, **kw):
            pass

        rc = my_fn._registered_commands[0]
        assert rc.provision_fn is my_provision

    def test_write_defaults_false(self):
        rc = RegisteredCommand(
            name="cat",
            spec=CommandSpec(rest=Operand(kind=OperandKind.PATH)),
            resource="ram",
            filetype=None,
            fn=lambda: None,
        )
        assert rc.write is False

    def test_write_flag_true(self):
        rc = RegisteredCommand(
            name="rm",
            spec=CommandSpec(),
            resource="s3",
            filetype=None,
            fn=lambda: None,
            write=True,
        )
        assert rc.write is True


class TestCommandDecoratorWrite:

    def test_write_flag_passed_through(self):
        spec = CommandSpec()

        @command("rm", resource="ram", spec=spec, write=True)
        async def my_rm(backend, paths, *texts, **kw):
            pass

        rc = my_rm._registered_commands[0]
        assert rc.write is True

    def test_write_flag_defaults_false(self):
        spec = CommandSpec()

        @command("cat", resource="ram", spec=spec)
        async def my_cat(backend, paths, *texts, **kw):
            pass

        rc = my_cat._registered_commands[0]
        assert rc.write is False


class TestCrossCommandDecorator:

    def test_cross_command_fields(self):
        spec = CommandSpec()

        @cross_command("cp", src="s3", dst="disk", spec=spec)
        async def my_cp(ws, paths, *texts, **kw):
            pass

        rc = my_cp._registered_commands[0]
        assert rc.name == "cp"
        assert rc.src == "s3"
        assert rc.dst == "disk"
        assert rc.resource == "s3->disk"


class TestVersionSupport:

    def test_auto_injects_version_option(self):
        spec = CommandSpec()

        @command("foo", resource="disk", spec=spec)
        async def my_fn(backend, paths, *texts, **kw):
            pass

        longs = [o.long for o in my_fn._registered_commands[0].spec.options]
        assert "--version" in longs
        assert "--help" in longs

    def test_version_short_circuits_handler(self):
        called = False

        @command("tsort", resource="disk", spec=CommandSpec())
        async def my_fn(backend, paths, *texts, **kw):
            nonlocal called
            called = True
            return None, None

        stdout, result = asyncio.run(my_fn._registered_commands[0].fn(
            None, [], version=True))
        assert called is False
        chunks = asyncio.run(_collect(stdout))
        assert chunks == f"tsort (Mirage) {__version__}\n".encode()
        assert result.exit_code == 0


async def _collect(source):
    if isinstance(source, (bytes, bytearray)):
        return bytes(source)
    parts = []
    async for chunk in source:
        parts.append(chunk)
    return b"".join(parts)
