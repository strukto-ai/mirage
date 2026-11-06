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

from collections.abc import Callable

_reader: list[Callable[[], str]] = [lambda: "bash: "]


def shell_voice() -> str:
    """How the running shell leads a diagnostic of its own, as a
    non-interactive bash does: the name of what it is reading and the line
    of the command running there (``bash: line 3: ``). ``bash: `` outside a
    shell, until the session context installs its reader (``use_voice``).
    """
    return _reader[0]()


def use_voice(reader: Callable[[], str]) -> Callable[[], str]:
    """Install what ``shell_voice`` reads the running shell with: the
    session context's, which a shell module cannot import, since the
    session imports it.

    Args:
        reader (Callable[[], str]): the running shell's voice.

    Returns:
        Callable[[], str]: the reader it replaced.
    """
    before = _reader[0]
    _reader[0] = reader
    return before
