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

from mirage.commands.config import RegisteredCommand, command, cross_command
from mirage.commands.spec import CommandSpec, Operand, OperandKind


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
