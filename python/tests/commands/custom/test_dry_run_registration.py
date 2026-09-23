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

from mirage.commands.registry import RegisteredCommand, command
from mirage.commands.spec import CommandSpec
from mirage.io.types import IOResult
from mirage.provision import ProvisionResult


async def my_cmd(backend, paths, *texts, **_extra):
    return b"ok", IOResult()


async def my_cmd_dry_run(backend, paths, *texts, **_extra):
    return ProvisionResult(command="my_cmd",
                           network_read_low=100,
                           network_read_high=100)


def test_registered_command_has_provision_fn():
    rc = RegisteredCommand(
        name="mycmd",
        spec=CommandSpec(),
        vfs="ram",
        filetype=None,
        fn=my_cmd,
        provision_fn=my_cmd_dry_run,
    )
    assert rc.provision_fn is my_cmd_dry_run


def test_registered_command_provision_fn_defaults_none():
    rc = RegisteredCommand(
        name="mycmd",
        spec=CommandSpec(),
        vfs="ram",
        filetype=None,
        fn=my_cmd,
    )
    assert rc.provision_fn is None


def test_command_decorator_with_dry_run():

    @command("mycmd", vfs="ram", spec=CommandSpec(), provision=my_cmd_dry_run)
    async def mycmd(backend, paths, *texts, **_extra):
        return b"ok", IOResult()

    rcs = mycmd._registered_commands
    assert len(rcs) == 1
    assert rcs[0].provision_fn is my_cmd_dry_run


def test_command_decorator_without_dry_run():

    @command("mycmd2", vfs="ram", spec=CommandSpec())
    async def mycmd2(backend, paths, *texts, **_extra):
        return b"ok", IOResult()

    rcs = mycmd2._registered_commands
    assert len(rcs) == 1
    assert rcs[0].provision_fn is None
