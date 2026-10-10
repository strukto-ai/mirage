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
from enum import Enum
from typing import Literal

from mirage.core.generic.find_eval import RowActionKind


@dataclass(frozen=True, slots=True)
class ExecAction:
    """One ``-exec`` action: the command words and how it is run.

    Args:
        argv (tuple[str, ...]): the words between ``-exec`` and its
            terminator, ``{}`` still in place.
        batch (bool): ``{} +`` (one run over every match) rather than
            ``;`` (one run per match).
    """

    argv: tuple[str, ...]
    batch: bool = False


@dataclass(frozen=True, slots=True)
class RowAction:
    """One of find's row actions, in the position it was written.

    Args:
        kind (RowActionKind): ``-print``, ``-print0``, ``-ls`` or
            ``-delete``.
    """

    kind: RowActionKind


@dataclass(frozen=True, slots=True)
class PrintfAction:
    """One ``-printf`` action: each row it reaches, rendered through a
    format.

    Args:
        format (str): the format as typed, escapes and directives
            unexpanded.
    """

    format: str


FindAction = ExecAction | RowAction | PrintfAction


class RegexSyntax(Enum):
    """The regex dialect a search pattern is written in.

    One translator per dialect turns it into host source: ``BASIC`` and
    ``EXTENDED`` are glibc's (grep's default and -E), ``PERL`` is
    PCRE2's (grep -P, rg -P) and ``RUST`` is ripgrep's default engine.
    The value is also the spelling a pushed-down search carries.
    """

    BASIC = "basic"
    EXTENDED = "extended"
    PERL = "perl"
    RUST = "rust"


@dataclass(frozen=True, slots=True)
class GrepSearchOptions:
    """The grep integration's per-request options, parsed from SearchQuery.

    Args:
        ignore_case (bool): -i, or rg's smart case over the pattern.
        fixed_string (bool): -F; a plain resource query is literal text.
        whole_word (bool): -w.
        syntax (RegexSyntax): the pattern's dialect.
        utf8 (bool): grep runs under a UTF-8 locale, so a line is
            matched as text rather than as its bytes.
    """

    ignore_case: bool = False
    fixed_string: bool = True
    whole_word: bool = False
    syntax: RegexSyntax = RegexSyntax.EXTENDED
    utf8: bool = False


@dataclass(frozen=True, slots=True)
class SearchTerms:
    """What grep or rg asks a mount's search, read off the line once.

    Args:
        texts (tuple[str, ...]): plain texts, one held by every match.
        whole_word (bool): each is needed only as a whole word.
        ignore_case (bool): the match folds case.
        line_output (bool): the output shows matching lines and nothing
            positional, so a file's matching lines can stand in for it.
        reads_binary (bool): the walk also reads binary-extension files.
    """

    texts: tuple[str, ...]
    whole_word: bool
    ignore_case: bool
    line_output: bool
    reads_binary: bool


@dataclass(frozen=True, slots=True)
class GrepSearchMeta:
    """The grep integration's declared search dialect and scan strategy."""

    mode: Literal["literal", "regex"]
    stream: bool = False
