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

from mirage.runtime.base import Runtime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.types import Language


def runtime_for_language(
    entries: list[Runtime], language: Language
) -> LanguageRuntime | None:
    """The world's interpreter for a script CLI.

    The first entry whose ``run`` speaks the language wins. There is no
    any-language fallback: a python program cannot run on a js engine,
    so no match means None and the caller reports the world's entries.

    Args:
        entries (list[Runtime]): the workspace's ordered world.
        language (Language): the script's language ("python" or "js").
    """
    return next(
        (
            entry
            for entry in entries
            if isinstance(entry, LanguageRuntime)
            and entry.language == language
        ),
        None,
    )
