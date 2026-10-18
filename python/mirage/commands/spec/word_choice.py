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

from dataclasses import dataclass
from typing import Literal

# The candidate words of an option that takes one of them, or an
# unambiguous prefix of one. Each entry is one VALUE, spelled either as
# the single word that names it or as a tuple of alias words that all
# mean it. The grouping is not cosmetic: it is the whole of GNU's
# ambiguity rule (two matching words inside one entry are one value and
# match; two matching entries are two values and are ambiguous), and it
# is what `valid_words_block` renders one `  - ` line per, which is
# how GNU answers `sort --check=x` with `  - 'quiet', 'silent'` on one
# line and `  - 'diagnose-first'` on the next.
WordChoices = tuple[str | tuple[str, ...], ...]

# The two wordings a refused value picks between, spelled as the word the
# message carries (`ls: invalid argument 'zzz' for '--time'`).
WordRefusalKind = Literal["ambiguous", "invalid"]


@dataclass(frozen=True, slots=True)
class WordMatch:
    """A value that resolved to exactly one candidate value.

    Args:
        word (str): the canonical spelling of that value -- the first
            word of its class, which is the spelling the caller looks
            the meaning up under, so `--sort=non` answers `none` and
            `--time=use` answers `atime`.
    """

    word: str


@dataclass(frozen=True, slots=True)
class WordRefusal:
    """A value GNU refuses, and which of its two wordings says so.

    Args:
        kind (WordRefusalKind): "ambiguous" when the value is a prefix of
            words spanning two or more values, "invalid" when it is a
            prefix of none.
    """

    kind: WordRefusalKind


WordChoiceResult = WordMatch | WordRefusal


def value_classes(choices: WordChoices) -> tuple[tuple[str, ...], ...]:
    """``choices`` as one tuple of alias words per value.

    A flat candidate tuple is a set of one-word values, which is what
    lets a spec's plain ``choices=`` reach the matcher with no change to
    its declaration.

    Args:
        choices (WordChoices): the candidates in declaration order.
    """
    grouped = (
        (choice,) if isinstance(choice, str) else tuple(choice)
        for choice in choices
    )
    return tuple(group for group in grouped if group)


def match_word(value: str, choices: WordChoices) -> WordChoiceResult:
    """One option value matched against its candidates, as GNU does.

    GNU's three answers, in one pass, measured against coreutils 9.4:

    1. An EXACT word wins outright, even when it is a proper prefix of
       a longer candidate: `ls --quoting-style=shell` is `shell`, not an
       ambiguity with `shell-always`, and `ls --color=no` is `never`.
    2. Otherwise every word ``value`` is a prefix of matches. Plain byte
       prefix, case-sensitive (`ls --sort=NON` is invalid, neither
       ambiguous nor accepted), and a hyphen is an ordinary character
       (`--quoting-style=shell-a` resolves).
    3. Matching words are ACCEPTED when they all mean one value, and
       ambiguous only when they span two or more: `ls -l --time=a` hits
       `atime` and `access`, one value, exit 0, while `--time=c` hits
       `ctime` and `creation`, two values, exit 1.

    There is deliberately no empty-string branch, and adding one would
    be a bug. `""` is a prefix of every candidate, so it falls through
    rule 2 into rule 3 and is ambiguous exactly when the candidates span
    two or more values -- which is why `ls --sort=` and `wc --total=`
    answer `ambiguous argument ''` while a one-value set accepts it.

    Args:
        value (str): the value as typed, never pre-escaped.
        choices (WordChoices): the candidates in declaration order,
            alias words of one value grouped into a tuple.

    Returns:
        WordChoiceResult: ``WordMatch`` carrying the canonical word,
            or ``WordRefusal`` carrying the wording GNU picks.
    """
    classes = value_classes(choices)
    for group in classes:
        if value in group:
            return WordMatch(group[0])
    matched = [
        group
        for group in classes
        if any(word.startswith(value) for word in group)
    ]
    if not matched:
        return WordRefusal("invalid")
    if len({group[0] for group in matched}) > 1:
        return WordRefusal("ambiguous")
    return WordMatch(matched[0][0])
