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

from mirage.commands.config import Command, CommandOpts, command
from mirage.commands.spec import SPECS, CommandSpec, Operand, Option
from mirage.version import __version__

_HANDLER_CALLS: list[str] = []


async def _noop_handler(backend, paths, texts, opts):
    return None, None


async def _recording_handler(backend, paths, texts, opts):
    _HANDLER_CALLS.append("called")
    return None, None


async def _collect(source):
    if isinstance(source, (bytes, bytearray)):
        return bytes(source)
    parts = []
    async for chunk in source:
        parts.append(chunk)
    return b"".join(parts)


class TestCommand:
    def test_basic_fields(self):
        rc = Command(
            name="cat",
            spec=CommandSpec(rest=Operand(type="path")),
            vfs="ram",
            filetype=None,
            fn=lambda: None,
        )
        assert rc.name == "cat"
        assert rc.vfs == "ram"
        assert rc.filetype is None

    def test_with_filetype(self):
        rc = Command(
            name="grep",
            spec=CommandSpec(),
            vfs="s3",
            filetype=".parquet",
            fn=lambda: None,
        )
        assert rc.filetype == ".parquet"


class TestCommandDecorator:
    def test_decorator_attaches_registered_commands(self):
        spec = CommandSpec(rest=Operand(type="path"))

        @command("mytest", vfs="ram", spec=spec)
        async def my_fn(backend, paths, *texts, **kw):
            pass

        assert hasattr(my_fn, "_registered_commands")
        assert len(my_fn._registered_commands) == 1
        rc = my_fn._registered_commands[0]
        assert rc.name == "mytest"
        assert rc.vfs == "ram"

    def test_wrapping_a_registered_function_does_not_mutate_it(self):
        original = command("cat", vfs="s3", spec=CommandSpec())(_noop_handler)
        original_registrations = list(original._registered_commands)

        wrapped = command("cat", vfs="s3", spec=CommandSpec())(original)

        assert original._registered_commands == original_registrations
        assert (
            wrapped._registered_commands is not original._registered_commands
        )
        assert len(wrapped._registered_commands) == 2

    def test_write_defaults_false(self):
        rc = Command(
            name="cat",
            spec=CommandSpec(rest=Operand(type="path")),
            vfs="ram",
            filetype=None,
            fn=lambda: None,
        )
        assert rc.write is False

    def test_write_flag_true(self):
        rc = Command(
            name="rm",
            spec=CommandSpec(),
            vfs="s3",
            filetype=None,
            fn=lambda: None,
            write=True,
        )
        assert rc.write is True


class TestCommandDecoratorWrite:
    def test_write_flag_passed_through(self):
        spec = CommandSpec()

        @command("rm", vfs="ram", spec=spec, write=True)
        async def my_rm(backend, paths, *texts, **kw):
            pass

        rc = my_rm._registered_commands[0]
        assert rc.write is True

    def test_write_flag_defaults_false(self):
        spec = CommandSpec()

        @command("cat", vfs="ram", spec=spec)
        async def my_cat(backend, paths, *texts, **kw):
            pass

        rc = my_cat._registered_commands[0]
        assert rc.write is False


class TestVersionSupport:
    def test_auto_injects_version_option(self):
        registered = command("foo", vfs="disk", spec=CommandSpec())(
            _noop_handler
        )
        longs = [
            o.long for o in registered._registered_commands[0].spec.options
        ]
        assert "--version" in longs
        assert "--help" in longs

    def test_version_short_circuits_handler(self):
        _HANDLER_CALLS.clear()
        registered = command("tsort", vfs="disk", spec=CommandSpec())(
            _recording_handler
        )
        stdout, result = asyncio.run(
            registered._registered_commands[0].fn(
                None, [], [], CommandOpts(flags={"version": True})
            )
        )
        assert _HANDLER_CALLS == []
        assert (
            asyncio.run(_collect(stdout))
            == f"tsort (Mirage) {__version__}\n".encode()
        )
        assert result.exit_code == 0

    def test_help_keeps_the_spec_epilog(self):
        registered = command(
            "foo", vfs="disk", spec=CommandSpec(epilog="Services:\n  drive")
        )(_noop_handler)
        rc = registered._registered_commands[0]
        assert rc.spec.epilog == "Services:\n  drive"
        stdout, result = asyncio.run(
            rc.fn(None, [], [], CommandOpts(flags={"help": True}))
        )
        assert b"Services:\n  drive\n" in asyncio.run(_collect(stdout))
        assert result.exit_code == 0

    def test_declared_version_reaches_the_handler(self):
        _HANDLER_CALLS.clear()
        registered = command(
            "custom",
            vfs=None,
            spec=CommandSpec(options=(Option(long="--version"),)),
        )(_recording_handler)
        asyncio.run(
            registered._registered_commands[0].fn(
                None, [], [], CommandOpts(flags={"version": True})
            )
        )
        assert _HANDLER_CALLS == ["called"]

    def test_help_reaches_a_program_that_runs_its_own_option_loop(self):
        # jq answers --help where its loop reaches it (OWN_OPTION_LOOP).
        _HANDLER_CALLS.clear()
        registered = command("jq", vfs=None, spec=SPECS["jq"])(
            _recording_handler
        )
        asyncio.run(
            registered._registered_commands[0].fn(
                None, [], [], CommandOpts(flags={"help": True})
            )
        )
        assert _HANDLER_CALLS == ["called"]

    def test_help_short_circuits_a_borrowed_name(self):
        _HANDLER_CALLS.clear()
        registered = command("jq", vfs=None, spec=CommandSpec())(
            _recording_handler
        )
        asyncio.run(
            registered._registered_commands[0].fn(
                None, [], [], CommandOpts(flags={"help": True})
            )
        )
        assert _HANDLER_CALLS == []
