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

from collections.abc import Iterable, Mapping

from mirage.commands.spec.parser import ParsedArgs
from mirage.commands.spec.types import FlagValue
from mirage.policy.types import CommandRead, FlagFact
from mirage.types import PathSpec


def _values(value: FlagValue | None) -> tuple[str, ...]:
    if isinstance(value, list):
        return tuple(v for part in value for v in _values(part))
    if isinstance(value, PathSpec):
        return (value.virtual,)
    if isinstance(value, str):
        return (value,)
    return ()


def flag_facts(
    flags: Mapping[str, FlagValue], dests: Iterable[str]
) -> tuple[FlagFact, ...]:
    """Each named option with the values it holds.

    Args:
        flags (Mapping[str, FlagValue]): option values by canonical
            spelling, as a parse or a walk left them.
        dests (Iterable[str]): the options the words carry, in order.
    """
    return tuple(FlagFact(dest, _values(flags.get(dest))) for dest in dests)


def _unread(word: str) -> str:
    name = word.split("=", 1)[0]
    return name if name.startswith("-") else f"-{name}"


def leaf_read(path: tuple[str, ...], parsed: ParsedArgs) -> CommandRead:
    """A leaf's parse as a read: the options the words carry, typed or
    filled from the environment, never a declared default, and the
    operands as written.

    A line the grammar refuses keeps all it did read, so a command that
    runs past the refusal (``find``'s ``-exec``, which its expression
    reads) is judged by its path, options and operands still. Each
    option word it could not read is one more option the tree does not
    name, which ``-*`` answers; a value handed to an option that takes
    none counts as that option.

    Args:
        path (tuple[str, ...]): the command name and its subcommands.
        parsed (ParsedArgs): the leaf's parse.
    """
    dests = [*parsed.typed_dests, *parsed.env_dests]
    unread = [
        *parsed.invalid_options,
        *(word for word, _ in parsed.ambiguous_options),
    ]
    return CommandRead(
        path,
        (
            *flag_facts(parsed.flags, dests),
            *(FlagFact(_unread(word), ()) for word in unread),
        ),
        tuple(word for word, _ in parsed.raw_operands),
    )
