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
import shlex
from collections.abc import Iterable

from mirage.shell.bytes import SURROGATE_BASE

_BYTE_SENTINEL = re.compile("[\udc80-\udcff]")


def _quote_token(token: str) -> str:
    return _BYTE_SENTINEL.sub(
        lambda m: f"'$'\\x{ord(m.group()) - SURROGATE_BASE:02x}''",
        shlex.quote(token),
    )


def shell_join(tokens: Iterable[str]) -> str:
    """Join tokens into one line the parser reads back as those tokens.

    ``shlex.join``, except that a byte UTF-8 cannot read, which a token
    carries as its surrogate escape, goes in as ``$'\\xHH'``: the parser
    reads UTF-8 only, and the escape expands back to that byte. Internal
    code that builds a line from words it already holds (``xargs``,
    ``env``, ``timeout``, ``find -exec``) goes through here, the twin of
    ``shellJoin`` in ``shell/join.ts``.

    Args:
        tokens (Iterable[str]): the words, each one argument.
    """
    return " ".join(_quote_token(token) for token in tokens)
