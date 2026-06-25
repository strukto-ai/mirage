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

from mirage.types import MountMode
from mirage.workspace.mount import MountEntry

HELP_HINT = (
    "Tip: run `man` to list every available command grouped by resource, "
    "`man <cmd>` for a single entry, and `<cmd> --help` for flag details.")


def build_file_prompt(mounts: list[MountEntry]) -> str:
    parts: list[str] = [HELP_HINT]
    for m in mounts:
        prompt = m.resource.PROMPT
        if not prompt:
            continue
        prefix = m.prefix.rstrip("/") or "/"
        section = prompt.format(prefix=prefix)
        if m.mode != MountMode.READ and m.resource.WRITE_PROMPT:
            section += "\n" + m.resource.WRITE_PROMPT.replace(
                "{prefix}", prefix)
        parts.append(section)
    return "\n\n".join(parts)
