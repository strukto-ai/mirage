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
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class OptionScan:
    """A bash builtin's option scan: letters as typed, then operands.

    Args:
        letters (tuple[str, ...]): every option letter in the order it
            was typed, repeats kept, so a builtin whose flags are
            mutually exclusive can apply bash's last-one-wins rule.
        operands (tuple[str, ...]): words from the first non-option on.
        bad (str | None): the first invalid option, spelled the way the
            refusal spells it, or None when every letter is known.
    """
    letters: tuple[str, ...] = ()
    operands: tuple[str, ...] = ()
    bad: str | None = None


def scan_options(args: Sequence[str], known: str) -> OptionScan:
    """Scan a bash builtin's leading option letters.

    bash builtins take single letters only (``internal_getopt``), which
    is a different grammar from the GNU tools ``parse_shell_options``
    serves: scanning is non-permuting and stops at ``--`` or the first
    non-option word, a token carries options only when it starts with a
    dash and is longer than one character, and every character after
    that dash is a letter. A long spelling therefore fails on its second
    dash, which is why bash refuses ``type --foo`` as ``--`` and not as
    ``--foo`` (pinned against bash 5.2, debian:stable-slim).

    Args:
        args (Sequence[str]): words after the builtin's name.
        known (str): the option letters this builtin accepts.
    """
    letters: list[str] = []
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if not (tok.startswith("-") and len(tok) > 1):
            break
        for ch in tok[1:]:
            if ch not in known:
                return OptionScan(bad=f"-{ch}")
            letters.append(ch)
        i += 1
    return OptionScan(letters=tuple(letters), operands=tuple(args[i:]))


def last_of(letters: Sequence[str], choices: str) -> str | None:
    """The last of a mutually exclusive letter group, as bash resolves it.

    bash holds such a group in one variable, so the last letter typed
    wins: ``type -tp`` prints a path and ``type -pt`` a type word, and
    ``command -vV`` is verbose where ``command -Vv`` is not.

    Args:
        letters (Sequence[str]): scanned letters, in typed order.
        choices (str): the mutually exclusive group.
    """
    return next((ch for ch in reversed(letters) if ch in choices), None)
