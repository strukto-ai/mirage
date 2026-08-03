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

from mirage.policy import CommandContext, GuardSpec, SpecPolicy, wildcard_regex
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace.mount import MountRegistry


def _registry() -> MountRegistry:
    registry = MountRegistry()
    registry.mount("/data", RAMResource(), MountMode.WRITE)
    return registry


def _path(virtual: str, raw: str | None = None) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path="",
                    raw_path=raw or virtual,
                    resolved=True)


def _ctx(command: str, paths: list[PathSpec]) -> CommandContext:
    return CommandContext(command=command,
                          paths=tuple(paths),
                          argv=(),
                          cwd="/",
                          registry=_registry())


def test_wildcard_star_crosses_slashes_and_question_is_one_char():
    assert wildcard_regex("/data/prod/*").match("/data/prod/a/b/c.txt")
    assert wildcard_regex("/data/?.txt").match("/data/a.txt")
    assert not wildcard_regex("/data/?.txt").match("/data/ab.txt")
    assert not wildcard_regex("/data/prod/*").match("/data/dev/x")


@pytest.mark.asyncio
async def test_spec_policy_matches_command_and_path():
    policy = SpecPolicy(
        GuardSpec(reason="prod is protected",
                  commands=("rm", "mv"),
                  paths=("/data/prod/*", )))
    deny = await policy.pre_command(
        _ctx("rm", [_path("/data/prod/x.txt", raw="prod/x.txt")]))
    assert deny is not None
    assert deny.message == "rm: prod/x.txt: prod is protected\n"
    assert deny.exit_code == 1
    assert await policy.pre_command(_ctx("rm",
                                         [_path("/data/dev/x.txt")])) is None
    assert await policy.pre_command(_ctx("cat",
                                         [_path("/data/prod/x.txt")])) is None


@pytest.mark.asyncio
async def test_spec_policy_without_paths_refuses_the_command_outright():
    policy = SpecPolicy(GuardSpec(reason="not here", commands=("shred", )))
    deny = await policy.pre_command(_ctx("shred", []))
    assert deny is not None
    assert deny.message == "shred: not here\n"


@pytest.mark.asyncio
async def test_spec_policy_without_commands_covers_every_command():
    policy = SpecPolicy(GuardSpec(reason="frozen", paths=("/data/locked/*", )))
    assert await policy.pre_command(_ctx("cat", [_path("/data/locked/a")])
                                    ) is not None
    assert await policy.pre_command(_ctx("rm",
                                         [_path("/data/open/a")])) is None
