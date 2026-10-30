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
from typing import Generic, TypeVar

T = TypeVar("T")

# What jq names standard input when it reports where it stands, and what
# it reports before it has read any input at all.
STDIN_NAME = "<stdin>"


@dataclass(frozen=True, slots=True)
class JqError:
    """An error no `try` caught, which ends one run: jq reports it and
    goes on with the next document.

    Args:
        text (str): the message as jq prints it: a string as it is,
            anything else in jq's own compact dump.
        string (bool): whether the message was a string, which jq's
            report says when it was not.
        own (bool): whether the program raised it with `error` itself,
            which jq never tells apart but gojq does.
    """

    text: str
    string: bool
    own: bool = False


@dataclass(frozen=True, slots=True)
class JqHalt:
    """`halt` or `halt_error`, which end the whole invocation.

    Args:
        message (str | None): halt_error's input as jq prints it (a
            string as it is, anything else in jq's compact dump), or None
            for `halt` and for a null input, which print nothing.
        string (bool): whether that input was a string, which jq prints
            with no newline of its own.
        code (float | None): the exit code `halt_error` named, or None
            for `halt`.
    """

    message: str | None
    string: bool
    code: float | None


@dataclass(frozen=True, slots=True)
class JqRun(Generic[T]):
    """What one run of a program printed, and what ended it early.

    Args:
        outputs (list[T]): every output it printed, in order: a value,
            or jq's own compact dump of one.
        stop (JqError | JqHalt | None): the error or the halt that ended
            it, or None when it ran to its end.
    """

    outputs: list[T]
    stop: JqError | JqHalt | None = None
