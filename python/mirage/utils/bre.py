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

# In a basic regular expression these are ordinary characters, and the
# backslashed spellings are the operators. That is the whole inversion:
# Python's engine reads them the other way round, so an untranslated BRE
# silently matches the wrong lines rather than failing.
BRE_LITERALS = "+?|(){}"
BACKREFERENCES = "123456789"
# A bracket expression takes its own rules: every character inside is
# ordinary, so the span is copied out untouched.
CLASS_INTRODUCERS = ":.="


def _bracket_end(pattern: str, start: int) -> int:
    """Index just past a bracket expression opening at ``start``.

    POSIX puts a literal ``]`` first, after an optional ``^``, and
    ``[:alpha:]``-style classes nest their own closing bracket, so
    neither ends the span.

    Args:
        pattern (str): the whole pattern.
        start (int): index of the opening ``[``.
    """
    i = start + 1
    n = len(pattern)
    if i < n and pattern[i] == "^":
        i += 1
    if i < n and pattern[i] == "]":
        i += 1
    while i < n and pattern[i] != "]":
        if (pattern[i] == "[" and i + 1 < n
                and pattern[i + 1] in CLASS_INTRODUCERS):
            closing = pattern[i + 1] + "]"
            end = pattern.find(closing, i + 2)
            i = i + 2 if end == -1 else end + 2
        else:
            i += 1
    return i + 1 if i < n else n


def _dollar_anchors(pattern: str, index: int) -> bool:
    """Whether a ``$`` at ``index`` is the end-of-line assertion.

    Only at the very end of the pattern or immediately before ``\\)``
    or ``\\|``; anywhere else it is a literal dollar sign. Pinned
    against GNU grep 3.x: ``a$b`` matches the three characters ``a$b``
    while ``\\(a$\\)`` anchors.

    Args:
        pattern (str): the whole pattern.
        index (int): index of the ``$``.
    """
    rest = pattern[index + 1:]
    return rest == "" or rest.startswith("\\)") or rest.startswith("\\|")


def bre_to_python(pattern: str) -> str:
    """Translate a POSIX basic regular expression to Python's dialect.

    grep, sed and expr read basic expressions unless told otherwise, and
    Python's ``re`` reads something close to an extended one, so handing
    a pattern straight over inverts every operator in it. ``a+b`` looks
    for a literal plus to grep and for a repeated ``a`` to Python, and
    both find something, which is why this went unnoticed: the failure
    is a wrong answer, not an error.

    Every rule below is pinned against GNU grep 3.x rather than taken
    from a specification, because the edge cases are where the two
    dialects differ most:

    - ``+ ? | ( ) { }`` are ordinary; ``\\+ \\? \\| \\( \\) \\{ \\}``
      are the operators (a GNU extension for the first three).
    - ``*`` is ordinary where nothing precedes it to repeat: at the
      start of the pattern, and after ``^``, ``\\(`` or ``\\|``.
      ``^*abc`` matches a literal asterisk.
    - ``^`` anchors only at those same starting positions, and ``$``
      only at the end or before ``\\)`` / ``\\|``. ``a^b`` and ``a$b``
      are three literal characters each.
    - A bracket expression is copied out whole: everything inside it is
      already ordinary in both dialects.

    Args:
        pattern (str): the expression as the user typed it.
    """
    out: list[str] = []
    index = 0
    length = len(pattern)
    # True where no expression precedes, so `*` cannot repeat anything
    # and `^` still anchors: the pattern start and just inside `\(`/`\|`.
    fresh = True
    while index < length:
        char = pattern[index]
        if char == "[":
            end = _bracket_end(pattern, index)
            out.append(pattern[index:end])
            index = end
            fresh = False
            continue
        if char == "\\" and index + 1 < length:
            following = pattern[index + 1]
            if following in BRE_LITERALS:
                out.append(following)
                fresh = following in "(|"
            elif following in BACKREFERENCES:
                out.append(f"\\{following}")
                fresh = False
            else:
                out.append(f"\\{following}")
                fresh = False
            index += 2
            continue
        if char in BRE_LITERALS:
            out.append(f"\\{char}")
            fresh = False
        elif char == "^":
            out.append("^" if fresh else "\\^")
        elif char == "$":
            out.append("$" if _dollar_anchors(pattern, index) else "\\$")
            fresh = False
        elif char == "*":
            out.append("*" if not fresh else "\\*")
            fresh = False
        else:
            out.append(char)
            fresh = False
        index += 1
    return "".join(out)
