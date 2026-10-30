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

import json
from collections.abc import Sequence

from mirage.commands.errors import UsageError
from mirage.io.types import IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import open_stream
from mirage.shell.bytes import byte_view, from_byte_view, text_view
from mirage.types import JsonValue


def scan(
    command: str, options: Sequence[tuple[str, str]]
) -> dict[str, JsonValue]:
    """A command's typed words, read by mirage-rs before any input is read.

    The tape holds each option as ``(dest, value)`` in the order typed, a
    switch with an empty value. A grammar that reads its operands also gets
    each operand as ``(OPERAND, word)`` where it was typed, a glob already
    expanded into its matches in its place. A value the command refuses
    never reaches an input.

    Args:
        command (str): the command whose grammar reads them.
        options (Sequence[tuple[str, str]]): the tape, in order.

    Returns:
        dict[str, JsonValue]: the values, keyed as the command's grammar
            answers.

    Raises:
        StreamRefusal: the first word the command refuses, with the
            command's exit status.
    """
    config: dict[str, JsonValue] = {
        "command": command,
        "options": [[name, byte_view(text)] for name, text in options],
    }
    values: dict[str, JsonValue] = json.loads(
        open_stream("scan", config).finish()
    )
    return values


def scanned(
    command: str, options: Sequence[tuple[str, str]]
) -> dict[str, JsonValue]:
    """``scan`` for a command whose refusals travel as usage errors.

    Args:
        command (str): the command whose grammar reads them.
        options (Sequence[tuple[str, str]]): each option's name and its
            value as typed, in the order typed.

    Raises:
        UsageError: the first value the command refuses, in its words and
            with its exit status.
    """
    try:
        return scan(command, options)
    except StreamRefusal as refusal:
        raise UsageError(text_view(refusal.message), refusal.status) from None


def refused(refusal: StreamRefusal) -> IOResult:
    """A scan's refusal as the command's result.

    Args:
        refusal (StreamRefusal): what ``scan`` raised.
    """
    return IOResult(
        exit_code=refusal.status,
        stderr=from_byte_view(f"{refusal.message}\n"),
    )


__all__ = ["refused", "scan", "scanned"]
