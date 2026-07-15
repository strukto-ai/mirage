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

from typing import Callable

from mirage.commands.builtin.ram import COMMANDS as _RAM_COMMANDS

_BY_NAME: dict[str, Callable] = {}
for _fn in _RAM_COMMANDS:
    for _rc in getattr(_fn, "_registered_commands"):
        if _rc.filetype is None and _rc.name not in _BY_NAME:
            _BY_NAME[_rc.name] = _fn

_GENERAL_NAMES = ("ls", "stat", "find", "tree", "du", "cat", "head", "tail",
                  "wc", "md5", "diff", "file", "nl", "grep", "rg", "sort",
                  "uniq", "cut", "tr", "mkdir", "touch", "cp", "mv", "rm",
                  "sed", "tee")

COMMANDS: dict[str, Callable] = {n: _BY_NAME[n] for n in _GENERAL_NAMES}

__all__ = ["COMMANDS"]
