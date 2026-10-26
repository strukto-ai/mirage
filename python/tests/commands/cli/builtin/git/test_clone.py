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

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.clone import (
    default_directory,
    remote_head,
)
from mirage.commands.cli.builtin.git.transport import Advertisement
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

ADV = Advertisement(
    {
        "HEAD": "c" * 40,
        "refs/heads/main": "c" * 40,
        "refs/heads/topic": "b" * 40,
        "refs/tags/v1": "t" * 40,
    },
    {"refs/tags/v1": "a" * 40},
    "refs/heads/main",
)


@pytest.mark.parametrize(
    "url,expected",
    [
        ("src", "src"),
        ("src/", "src"),
        ("src/.git", "src"),
        ("repos/proj.git", "proj"),
        ("repos/proj.git/", "proj"),
        ("https://github.com/octocat/Hello-World.git", "Hello-World"),
        ("git@github.com:octocat/Hello-World", "Hello-World"),
    ],
)
def test_the_directory_is_named_after_the_repository(url, expected):
    assert default_directory(url) == expected


@pytest.mark.parametrize(
    "chosen,expected",
    [
        (None, ("main", "c" * 40)),
        ("topic", ("topic", "b" * 40)),
        ("v1", (None, "a" * 40)),
        ("nosuch", ("nosuch", None)),
    ],
)
def test_the_checkout_follows_head_or_the_named_branch_or_tag(
    chosen, expected
):
    assert remote_head(ADV, chosen) == expected


def test_a_detached_remote_head_is_checked_out_detached():
    adv = Advertisement({"HEAD": "c" * 40, "refs/heads/main": "b" * 40})
    assert remote_head(adv, None) == (None, "c" * 40)


@pytest.mark.asyncio
async def test_a_third_operand_is_too_many_arguments():
    with Workspace({"/w/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("mkdir /w/b && echo x > /w/b/f")
        result = await ws.shell("cd /w && git clone a b c")
    assert result.exit_code == 129
    assert result.stderr.startswith(
        b"fatal: Too many arguments.\n\nusage: git clone "
    )
