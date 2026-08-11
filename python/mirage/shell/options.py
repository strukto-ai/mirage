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

from mirage.shell.types import SET_FLAG_TO_OPTION


@dataclass(frozen=True, slots=True)
class OptionWord:
    """One word of the shell's option grammar.

    Args:
        settings (tuple[tuple[str, bool], ...]): shell options the word
            turns on or off, in the order they were written.
        other (str): cluster letters that name no shell option. `set`
            ignores them; shell startup reads its own startup letters
            out of them and refuses the rest.
        consumed (int): words the option took, 2 for the `-o NAME` form.
    """
    settings: tuple[tuple[str, bool], ...] = ()
    other: str = ""
    consumed: int = 1


def parse_option_word(word: str, nxt: str | None) -> OptionWord | None:
    """Read one option word, or None when the word is an operand.

    This is bash's `set` grammar, which shell startup speaks too: a
    sign, then either `o` naming an option in the next word or a cluster
    of single-letter options, where `-` turns them on and `+` turns them
    off. `bash -x file` and `set -x` therefore cannot disagree about
    what `-x` means, and an option one of them learns the other gets.

    `-`, `--` and a `--long` word are not option words. The first two
    end option parsing and the third belongs to whoever declares long
    options, so both are the caller's to answer.

    Args:
        word (str): the word to read.
        nxt (str | None): the word after it, for the `-o NAME` form.
    """
    if len(word) < 2 or word[0] not in "-+" or word.startswith("--"):
        return None
    enable = word[0] == "-"
    settings: list[tuple[str, bool]] = []
    other = ""
    consumed = 1
    for char in word[1:]:
        if char == "o":
            if nxt is not None:
                settings.append((nxt, enable))
                consumed = 2
            continue
        option = SET_FLAG_TO_OPTION.get(char)
        if option is None:
            other += char
            continue
        settings.append((option, enable))
    return OptionWord(settings=tuple(settings), other=other, consumed=consumed)
