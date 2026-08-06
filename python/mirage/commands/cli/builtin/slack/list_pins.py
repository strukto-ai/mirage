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

import json

from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.pins import list_pins as list_pins_core
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def list_pins(
        inv: CLIInvocation[SlackConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    items = await list_pins_core(inv.config, fl.as_str("channel") or "")
    out = json.dumps(items, ensure_ascii=False, separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
