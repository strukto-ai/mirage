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

_MODE_CLASS_BITS = {"u": 0o700, "g": 0o070, "o": 0o007, "a": 0o777}
_MODE_PERM_BITS = {"r": 0o444, "w": 0o222, "x": 0o111}
_MODE_CLAUSE_RE = re.compile(r"([ugoa]*)([+\-=])([rwx]*)")

DEFAULT_DIR_MODE = 0o755
DEFAULT_FILE_MODE = 0o644


def parse_mode(text: str, current: int) -> int | None:
    """Parse a chmod MODE argument (octal or symbolic).

    Symbolic supports the common grammar: ``[ugoa...][+-=][rwx...]``
    clauses joined by commas (``u+x``, ``go-w``, ``a=r``, ``+x``).
    Special bits (s, t, X) are not supported.

    Args:
        text (str): the MODE operand as typed.
        current (int): current permission bits the clauses apply to.

    Returns:
        int | None: the new mode, or None when the text does not parse.

    Example::

        parse_mode("644", 0)          -> 0o644
        parse_mode("u+x", 0o644)      -> 0o744
        parse_mode("a=r", 0o777)      -> 0o444
    """
    if text and all(c in "01234567" for c in text):
        value = int(text, 8)
        return value if value <= 0o7777 else None

    mode = current
    for clause in text.split(","):
        match = _MODE_CLAUSE_RE.fullmatch(clause)
        if match is None:
            return None
        classes, action, perms = match.groups()
        class_mask = 0
        for c in classes or "a":
            class_mask |= _MODE_CLASS_BITS[c]
        perm_mask = 0
        for c in perms:
            perm_mask |= _MODE_PERM_BITS[c]
        bits = class_mask & perm_mask
        if action == "+":
            mode |= bits
        elif action == "-":
            mode &= ~bits
        else:
            mode = (mode & ~class_mask) | bits
    return mode


__all__ = ["DEFAULT_DIR_MODE", "DEFAULT_FILE_MODE", "parse_mode"]
