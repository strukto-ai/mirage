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

from mirage.commands.cli.builtin.discord import DISCORD
from mirage.commands.spec.compile import compile_spec
from mirage.core.discord.config import DiscordConfig

VERBS = [
    "send",
    "read",
    "edit",
    "delete",
    "react",
    "search",
    "thread-create",
    "poll",
    "members",
    "server-info",
]


def leaf(name: str):
    return next(c for c in DISCORD.spec.subcommands if c.name == name)


def test_tree_shape_matches_the_openclaw_vocabulary():
    assert DISCORD.spec.name == "discord"
    assert DISCORD.config_model is DiscordConfig
    assert [v.name for v in DISCORD.spec.subcommands] == VERBS


def test_write_classification():
    writers = {
        v.name
        for v in DISCORD.spec.subcommands
        if DISCORD.handlers[v.name].write
    }
    assert writers == {
        "send",
        "edit",
        "delete",
        "react",
        "thread-create",
        "poll",
    }


def test_poll_answer_flag_is_repeatable():
    answer = next(
        o for o in compile_spec(leaf("poll")).options if "--answer" in o.names
    )
    assert answer.action == "append"
    assert answer.required
