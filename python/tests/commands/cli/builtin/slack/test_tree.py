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

from mirage.commands.cli.builtin.slack import SLACK
from mirage.core.slack.config import SlackConfig

VERBS = [
    "send-message",
    "read-messages",
    "react",
    "reactions",
    "pin-message",
    "unpin-message",
    "list-pins",
    "member-info",
    "list-members",
    "emoji-list",
    "search",
]


def leaf(name: str):
    return next(c for c in SLACK.subcommands if c.name == name)


def test_tree_shape_matches_the_openclaw_vocabulary():
    assert SLACK.name == "slack"
    assert SLACK.config_model is SlackConfig
    assert [v.name for v in SLACK.subcommands] == VERBS


def test_write_classification():
    writers = {v.name for v in SLACK.subcommands if v.write}
    assert writers == {
        "send-message",
        "react",
        "pin-message",
        "unpin-message",
    }


def test_required_flags():
    required = {o.long for o in leaf("send-message").options if o.required}
    assert required == {"--channel", "--text"}
    assert not any(o.required for o in leaf("emoji-list").options)
