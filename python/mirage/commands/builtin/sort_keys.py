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

from mirage.commands.builtin.errors import SortKeyError
from mirage.commands.errors import UsageError
from mirage.commands.quote import quote_text

# The ordering letters GNU sort takes after a KEYDEF position. R is
# recognized, so it still keeps a key off the global options and counts
# against the others it is incompatible with, but it does not shuffle.
_ORDER_LETTERS = frozenset("bdfghiMnRrV")
# What strtoumax skips before a number, isspace() in the C locale.
_BLANKS = frozenset(" \t\n\v\f\r")


@dataclass(frozen=True, slots=True)
class KeyMods:
    numeric: bool = False
    general_numeric: bool = False
    human: bool = False
    version: bool = False
    month: bool = False
    fold: bool = False
    reverse: bool = False
    dictionary: bool = False
    ignore_nonprinting: bool = False
    random: bool = False


@dataclass(frozen=True, slots=True)
class Key:
    start_field: int
    start_char: int
    start_skip: bool
    end_field: int | None
    end_char: int | None
    end_skip: bool
    mods: KeyMods


@dataclass(frozen=True, slots=True)
class SortConfig:
    keys: tuple[Key, ...]
    field_sep: int | None
    reverse: bool
    unique: bool
    stable: bool


def _field_count(spec: str, pos: int, what: str) -> tuple[int, int]:
    """A KEYDEF field or offset number: the decimal starting at ``pos``.

    strtoumax's reading, so leading blanks and a ``+`` are taken and the
    number ends at the first byte that is not an ASCII digit, which the
    caller reads on from. A ``-``, or no digit at all, is refused with the
    text from ``pos`` on.

    Args:
        spec (str): the whole KEYDEF.
        pos (int): where the number should start.
        what (str): what the number is, for the refusal.

    Returns:
        tuple[int, int]: the number and the index just past it.

    Raises:
        SortKeyError: no number starts at ``pos``.
    """
    end = pos
    while end < len(spec) and spec[end] in _BLANKS:
        end += 1
    if end < len(spec) and spec[end] == "+":
        end += 1
    digits = end
    while end < len(spec) and "0" <= spec[end] <= "9":
        end += 1
    if end == digits:
        raise SortKeyError(
            f"{what}: invalid count at start of '{quote_text(spec[pos:])}'"
        )
    return int(spec[digits:end]), end


def _bad_field_spec(spec: str, why: str) -> SortKeyError:
    return SortKeyError(
        f"{why}: invalid field specification '{quote_text(spec)}'"
    )


def _ordering(spec: str, pos: int) -> tuple[str, int]:
    end = pos
    while end < len(spec) and spec[end] in _ORDER_LETTERS:
        end += 1
    return spec[pos:end], end


def _mods_from_letters(letters: str) -> KeyMods:
    return KeyMods(
        numeric="n" in letters,
        general_numeric="g" in letters,
        human="h" in letters,
        version="V" in letters,
        month="M" in letters,
        fold="f" in letters,
        reverse="r" in letters,
        dictionary="d" in letters,
        ignore_nonprinting="i" in letters,
        random="R" in letters,
    )


def parse_keydef(spec: str, global_mods: KeyMods, global_skip: bool) -> Key:
    """One ``-k`` KEYDEF, read and refused the way GNU sort 9.7 does.

    ``F[.C][OPTS][,F[.C][OPTS]]``, taken left to right: each number is
    checked as it is read, so ``-k0.x`` names the zero field and not the
    bad offset, and ordering letters run until the first byte that is not
    one, where anything left over is a stray character. A start offset
    of zero is refused and an end offset of zero means the end of its
    field. A key that carries any letter of its own, ``b`` included,
    takes none of the global options.

    Args:
        spec (str): the KEYDEF as typed.
        global_mods (KeyMods): the global ordering options.
        global_skip (bool): the global ``-b``.

    Raises:
        SortKeyError: a KEYDEF GNU refuses, in its words.
    """
    start_field, pos = _field_count(spec, 0, "invalid number at field start")
    if start_field == 0:
        raise _bad_field_spec(spec, "field number is zero")
    start_char = 1
    if pos < len(spec) and spec[pos] == ".":
        start_char, pos = _field_count(
            spec, pos + 1, "invalid number after '.'"
        )
        if start_char == 0:
            raise _bad_field_spec(spec, "character offset is zero")
    start_letters, pos = _ordering(spec, pos)
    end_field: int | None = None
    end_char: int | None = None
    end_letters = ""
    if pos < len(spec) and spec[pos] == ",":
        end_field, pos = _field_count(
            spec, pos + 1, "invalid number after ','"
        )
        if end_field == 0:
            raise _bad_field_spec(spec, "field number is zero")
        if pos < len(spec) and spec[pos] == ".":
            end_char, pos = _field_count(
                spec, pos + 1, "invalid number after '.'"
            )
        end_letters, pos = _ordering(spec, pos)
    if pos < len(spec):
        raise _bad_field_spec(spec, "stray character in field spec")
    if start_letters or end_letters:
        mods = _mods_from_letters(start_letters + end_letters)
        start_skip = "b" in start_letters
        end_skip = "b" in end_letters
    else:
        mods = global_mods
        start_skip = global_skip
        end_skip = global_skip
    return Key(
        start_field=start_field,
        start_char=start_char,
        start_skip=start_skip,
        end_field=end_field,
        end_char=end_char,
        end_skip=end_skip,
        mods=mods,
    )


def _incompatible_letters(mods: KeyMods) -> str:
    """The letters GNU sort refuses to combine on one key.

    A key orders by at most one of ``-n``, ``-g``, ``-h``, ``-M`` and the
    group ``-V``, ``-R``, ``-d``, ``-i``, whose members combine with each
    other but with none of the rest. The refusal spells the key's
    letters without ``-b`` and ``-r`` (``options '-gn' are
    incompatible``), and ``-d`` hides ``-i`` because GNU keeps only the
    stronger of the two filters.

    Args:
        mods (KeyMods): one key's options, inherited ones included.

    Returns:
        str: the letters to name, or ``""`` for a compatible key.
    """
    text_orders = (
        mods.version
        or mods.random
        or mods.dictionary
        or mods.ignore_nonprinting
    )
    orderings = (
        mods.numeric
        + mods.general_numeric
        + mods.human
        + mods.month
        + text_orders
    )
    if orderings <= 1:
        return ""
    spelled = (
        ("d", mods.dictionary),
        ("f", mods.fold),
        ("g", mods.general_numeric),
        ("h", mods.human),
        ("i", mods.ignore_nonprinting and not mods.dictionary),
        ("M", mods.month),
        ("n", mods.numeric),
        ("R", mods.random),
        ("V", mods.version),
    )
    return "".join(letter for letter, given in spelled if given)


def tab_byte(text: str) -> int:
    """``-t``'s separator as GNU sort reads it: one byte, ``\\0`` for NUL.

    Args:
        text (str): the option argument, raw bytes surrogate-escaped.

    Raises:
        UsageError: an empty or a multi-character tab.
    """
    raw = text.encode("utf-8", "surrogateescape")
    if not raw:
        raise UsageError("sort: empty tab")
    if raw == b"\\0":
        return 0
    if len(raw) > 1:
        raise UsageError(f"sort: multi-character tab '{quote_text(text)}'")
    return raw[0]


def build_config(
    key_defs: list[str],
    field_sep: str | None,
    reverse: bool,
    numeric: bool,
    unique: bool,
    fold_case: bool,
    human_numeric: bool,
    version_sort: bool,
    month_sort: bool,
    ignore_blanks: bool,
    stable: bool,
    general_numeric: bool = False,
    dictionary: bool = False,
    ignore_nonprinting: bool = False,
) -> SortConfig:
    """The comparison sort runs, refusing a key that mixes orderings.

    GNU checks the orderings once the option loop is done, key by key in
    the order the keys were typed, so a bad KEYDEF, a second ``-o`` or a
    second check mode outranks it and it outranks ``-c``'s operand
    checks. The global options count only through the keys that inherit
    them, so ``sort -n -g -k1,1n`` runs; with no ``-k`` they are the one
    key.

    Args:
        key_defs (list[str]): each ``-k`` as typed.
        field_sep (str | None): ``-t`` as typed.
        reverse (bool): ``-r``.
        numeric (bool): ``-n``.
        unique (bool): ``-u``.
        fold_case (bool): ``-f``.
        human_numeric (bool): ``-h``.
        version_sort (bool): ``-V``.
        month_sort (bool): ``-M``.
        ignore_blanks (bool): ``-b``.
        stable (bool): ``-s``.
        general_numeric (bool): ``-g``.
        dictionary (bool): ``-d``.
        ignore_nonprinting (bool): ``-i``.

    Raises:
        SortKeyError: a KEYDEF GNU refuses, or a key whose orderings are
            incompatible.
    """
    global_mods = KeyMods(
        numeric=numeric,
        general_numeric=general_numeric,
        human=human_numeric,
        version=version_sort,
        month=month_sort,
        fold=fold_case,
        reverse=reverse,
        dictionary=dictionary,
        ignore_nonprinting=ignore_nonprinting,
    )
    if key_defs:
        keys = tuple(
            parse_keydef(spec, global_mods, ignore_blanks) for spec in key_defs
        )
    else:
        keys = (
            Key(1, 1, ignore_blanks, None, None, ignore_blanks, global_mods),
        )
    for key in keys:
        letters = _incompatible_letters(key.mods)
        if letters:
            raise SortKeyError(f"options '-{letters}' are incompatible")
    return SortConfig(
        keys=keys,
        field_sep=None if field_sep is None else tab_byte(field_sep),
        reverse=reverse,
        unique=unique,
        stable=stable,
    )
