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

from mirage.policy.constants import WILDCARD


def split_pattern(pattern: str) -> tuple[str, ...]:
    """A command pattern's tokens.

    Whitespace-split; trailing wildcards are dropped because a pattern
    is a prefix and already matches any continuation (``git *`` and
    ``git`` are the same rule; a bare ``*`` is every command).

    Args:
        pattern (str): the pattern as written in the document.
    """
    tokens = tuple(pattern.split())
    while tokens and tokens[-1] == WILDCARD:
        tokens = tokens[:-1]
    return tokens


def pattern_matches(pattern: str, tokens: Sequence[str]) -> bool:
    """Whether a pattern is a prefix of a line's tokens.

    Args:
        pattern (str): the pattern as written.
        tokens (Sequence[str]): the line as the entry point normalized it,
            command name first.
    """
    want = split_pattern(pattern)
    if len(want) > len(tokens):
        return False
    return all(w == WILDCARD or w == t for w, t in zip(want, tokens))


def pattern_reaches(pattern: str, path: Sequence[str]) -> bool:
    """Whether a pattern can match some line running the node at a path.

    Neither side has to be the longer one, which is what separates this
    from :func:`pattern_matches`: only the words the two share are read.
    A pattern that runs past the path narrows what is reachable below it
    (``linear issue list`` reaches ``linear issue``, because one line of
    that group is allowed); a path that runs past the pattern is already
    covered (``linear issue`` reaches ``linear issue list``).

    Args:
        pattern (str): the pattern as written.
        path (Sequence[str]): the node's canonical words, head first.
    """
    want = split_pattern(pattern)
    return all(w == WILDCARD or w == t for w, t in zip(want, path))


def pattern_names(pattern: str, name: str) -> bool:
    """Whether a pattern can match some line of a command.

    Visibility asks this: a name is installed for the session when a
    pattern of every allow list starts with it (or with the wildcard),
    whatever the rest of the pattern requires of the line. The one-word
    case of :func:`pattern_reaches`.

    Args:
        pattern (str): the pattern as written.
        name (str): the command name.
    """
    return pattern_reaches(pattern, (name,))
