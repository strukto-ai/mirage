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

from collections.abc import Sequence
from typing import Any

from mirage.runtime.base import Runtime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.table import placement
from mirage.runtime.types import Language


def runtime_for_script(
    entries: Sequence[Runtime[Any]],
    machine: str,
    runtime: str | None,
    language: Language,
) -> LanguageRuntime[Any] | None:
    """The workspace entry that runs a script CLI.

    The first entry on a ``machine`` machine that speaks the script's
    language wins, or the first that is the named ``runtime``. There is
    no any-language fallback: a python program cannot run on a js
    engine, so no match means None and the caller reports the world's
    entries.

    Args:
        entries (Sequence[Runtime]): the workspace's ordered world.
        machine (str): the machine the script runs on: ``in_process``,
            ``worker`` or ``host``.
        runtime (str | None): the runtime's registered name, such as
            ``quickjs``; None for the first that speaks the language.
        language (Language): the script's language ("python" or "js").
    """
    for entry in entries:
        if not isinstance(entry, LanguageRuntime):
            continue
        if entry.language != language:
            continue
        provider, name = placement(entry)
        if provider == machine and runtime in (None, name):
            return entry
    return None
