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

from importlib.resources import files

# INCR hands out the dense seq and XADD stores the chunk under the
# stream id ``(seq+1)-0`` in one atomic step, so two appends racing (a
# kill marker against a runner's last emit) cannot collide on an id.
# Shipped next to this module; byte-identical to the TypeScript
# append.lua.
APPEND_LUA = (files("mirage.shell.console.redis") /
              "append.lua").read_text(encoding="utf-8")

BLOCK_MS = 250
