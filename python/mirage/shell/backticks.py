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

from mirage.shell.types import BacktickSegment

_ESCAPABLE = frozenset({"$", "`", "\\"})


def split_backtick_region(raw: str) -> list[BacktickSegment]:
    """Split a backtick region into its commands and the text between
    them, each with its span in the region.

    tree-sitter-bash lexes the gap between two backtick substitutions
    as a single token when that gap is empty or whitespace-only, so
    ``\\`a\\` \\`b\\``` arrives as ONE command_substitution node holding
    both commands and the literal text between them, and the node's
    subtree merges the two commands into one that never runs.
    Re-lexing the node's own text on unescaped backticks recovers the
    real segments; a single pair simply yields one command segment.
    The evaluator runs each command as a line of its own and the
    judging pass reads it the same way, so this is the one lexer both
    share, and the spans are what let each pair stand at its own place
    on the line.

    Inside a command, POSIX keeps the backslash literal except before
    ``$``, `` ` `` and ``\\``, where it escapes. Consuming those pairs
    whole is what makes the parity right: ``\\\\`` is one escaped
    backslash, so a backtick straight after it still closes the region
    rather than reading as an escaped backtick.

    Args:
        raw (str): the region's text, opening and closing with a
            backtick.
    """
    segments: list[BacktickSegment] = []
    buf: list[str] = []
    in_command = False
    start = 0
    i = 0
    while i < len(raw):
        if (raw[i] == "\\" and in_command and i + 1 < len(raw)
                and raw[i + 1] in _ESCAPABLE):
            buf.append(raw[i + 1])
            i += 2
            continue
        if raw[i] == "`":
            segments.append(BacktickSegment("".join(buf), in_command, start,
                                            i))
            buf = []
            in_command = not in_command
            i += 1
            start = i
            continue
        buf.append(raw[i])
        i += 1
    segments.append(BacktickSegment("".join(buf), in_command, start, len(raw)))
    return [s for s in segments if s.text or s.command]
