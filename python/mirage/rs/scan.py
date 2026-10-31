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
from mirage.commands.spec.constants import PARSE_KEPT_CHARS, PARSES_KEPT
from mirage.io.types import IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import open_stream
from mirage.shell.bytes import byte_view, from_byte_view, text_view
from mirage.types import JsonValue

# What each command's scan answered, by tape; see ``scan``.
_SCANS: dict[
    str, dict[tuple[tuple[str, str], ...], bytes | StreamRefusal]
] = {}


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

    A tape's answer is kept, per command, as a spec keeps its parses
    (PARSES_KEPT, PARSE_KEPT_CHARS), so the admission gate and the
    handler reading one line's options share one scan; each entry counts
    its name, its value and one more toward PARSE_KEPT_CHARS, so a run of
    switches is bounded too. It is kept as the text mirage-rs answered and
    decoded per reader, so no reader sees another's changes; a refusal is
    kept as a copy never raised, so no traceback holds the refused call.
    """
    tape = tuple(options)
    kept = None
    answers = None
    if sum(1 + len(name) + len(text) for name, text in tape) <= (
        PARSE_KEPT_CHARS
    ):
        answers = _SCANS.setdefault(command, {})
        kept = answers.get(tape)
    if kept is None:
        config: dict[str, JsonValue] = {
            "command": command,
            "options": [[name, byte_view(text)] for name, text in tape],
        }
        try:
            kept = open_stream("scan", config).finish()
        except StreamRefusal as refusal:
            kept = StreamRefusal(
                refusal.message, refusal.output, refusal.status
            )
        if answers is not None:
            if len(answers) >= PARSES_KEPT:
                answers.clear()
            answers[tape] = kept
    if isinstance(kept, StreamRefusal):
        raise StreamRefusal(kept.message, kept.output, kept.status)
    values: dict[str, JsonValue] = json.loads(kept)
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
