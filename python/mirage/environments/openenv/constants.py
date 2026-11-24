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

from mirage.types import JsonValue
from mirage.workspace.tools.tool_descriptions import (
    EDIT_INPUT,
    GLOB_INPUT,
    GREP_INPUT,
    LS_INPUT,
    READ_INPUT,
    SHELL_INPUT,
    WRITE_INPUT,
)

INPUTS: dict[str, dict[str, JsonValue]] = {
    "shell": SHELL_INPUT,
    "read": READ_INPUT,
    "write": WRITE_INPUT,
    "edit": EDIT_INPUT,
    "ls": LS_INPUT,
    "grep": GREP_INPUT,
    "glob": GLOB_INPUT,
}

TIMEOUT_EXIT = 124

NOT_OFFERED_EXIT = 126

SERVER_NAME = "mirage"
