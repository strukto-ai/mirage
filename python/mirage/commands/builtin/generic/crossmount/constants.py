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

STREAM_COMMANDS = frozenset({"cat", "nl", "sort", "cut", "sed", "rev"})
FANOUT_COMMANDS = frozenset({
    "grep", "rg", "head", "tail", "wc", "du", "file", "md5", "sha256sum",
    "stat", "strings", "tac", "ls", "find", "rm", "touch", "mkdir", "tee"
})
RELAY_COMMANDS = frozenset({"cp", "mv", "diff", "cmp"})
CROSS_MOUNT_COMMANDS = STREAM_COMMANDS | FANOUT_COMMANDS | RELAY_COMMANDS
