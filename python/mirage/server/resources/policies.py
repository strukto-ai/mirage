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

import re
from typing import Any

from mirage.resources.base import ResourceStore

# A saved policy's name: a file name mirage reads as Python.
POLICY_NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,59}\.py")


async def with_policies(
    store: ResourceStore, written: dict[str, Any]
) -> dict[str, Any]:
    """``written`` with each profile program whose ``script`` names a saved
    policy given that policy's source, so ``script: guard.py`` in a
    template means the saved policy here as on the console. A script
    naming no saved policy stays a path; ``written`` comes back as it is
    when no script changes.

    Args:
        store (ResourceStore): where the policies are saved.
        written (dict[str, Any]): the config as written.
    """
    profiles = written.get("profiles")
    if not isinstance(profiles, dict):
        return written
    saved: dict[str, str] | None = None
    changed = False
    out: dict[str, Any] = {}
    for name, profile in profiles.items():
        if not isinstance(profile, dict) or not isinstance(
            profile.get("policy"), dict
        ):
            out[name] = profile
            continue
        policy: dict[str, Any] = {}
        for method, programs in profile["policy"].items():
            if not isinstance(programs, list):
                policy[method] = programs
                continue
            swapped: list[Any] = []
            for program in programs:
                script = (
                    program.get("script")
                    if isinstance(program, dict)
                    else None
                )
                if isinstance(script, str) and POLICY_NAME.fullmatch(script):
                    if saved is None:
                        saved = {
                            p.name: p.source
                            for p in await store.list_policies()
                        }
                    source = saved.get(script)
                    if source is not None:
                        swapped.append(
                            {
                                **program,
                                "script": {
                                    "source": source,
                                    "language": "python",
                                },
                            }
                        )
                        changed = True
                        continue
                swapped.append(program)
            policy[method] = swapped
        out[name] = {**profile, "policy": policy}
    return {**written, "profiles": out} if changed else written
