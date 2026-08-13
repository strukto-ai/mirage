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

from mirage.commands.cli.builtin.gh.accessor import gh_repo, json_out, text_out
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.github.config import GhConfig
from mirage.core.github.repo import (fork_repo, login, rename_repo, view_repo)
from mirage.io.types import ByteSource, IOResult


async def view(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    operand = inv.texts[0] if inv.texts else None
    return json_out(await view_repo(inv.config, gh_repo(inv.config, operand)))


async def fork(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    operand = inv.texts[0] if inv.texts else None
    source = gh_repo(inv.config, operand)
    name = fl.as_str("fork_name")
    forked = await fork_repo(inv.config, source, name)
    landed = forked.get("full_name") if isinstance(forked, dict) else None
    full = landed if isinstance(landed, str) else (
        f"{await login(inv.config)}/{name or source.repo}")
    return text_out(f"✓ Created fork {full}\n")


async def rename(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    # gh takes the *new name* as the operand and the repository to rename as
    # -R, which is the reverse of what the shape of the line suggests.
    target = gh_repo(inv.config, fl.as_str("repo"))
    name = inv.texts[0] if inv.texts else ""
    if not name:
        raise ValueError("a new repository name is required")
    renamed = await rename_repo(inv.config, target, name)
    landed = renamed.get("full_name") if isinstance(renamed, dict) else None
    full = landed if isinstance(landed, str) else name
    return text_out(f"✓ Renamed repository {full}\n")
