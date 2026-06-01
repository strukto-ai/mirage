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

from mirage.commands.builtin.databricks_volume import COMMANDS

TEXT_COMMANDS = {
    "awk",
    "cut",
    "diff",
    "jq",
    "nl",
    "sed",
    "sort",
    "tr",
    "uniq",
    "wc",
}


def test_databricks_volume_text_commands_registered_read_only():
    registered = [
        registered for command in COMMANDS
        for registered in command._registered_commands
    ]
    names = {command.name for command in registered}
    assert TEXT_COMMANDS <= names
    for command in registered:
        if command.name in TEXT_COMMANDS:
            assert command.resource == "databricks_volume"
            assert not command.write
