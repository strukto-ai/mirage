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

from mirage.io.types import IOResult
from mirage.policy import describe_refusal, says_why
from mirage.types import Refusal


def decode(value: bytes | None) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", errors="replace")


def refusal_line(text: str, refusal: Refusal | None) -> str:
    """The one line a text surface appends for a refusal, newline
    included, or the empty string when there is nothing to add: no
    record, or a text that already says why (an operand-scoped
    denial's GNU line, wherever a redirect landed it). A command-scoped
    refusal's stderr is bash's bare ``Permission denied``, which never
    does.

    Args:
        text (str): what the surface is about to hand over.
        refusal (Refusal | None): the record off the result.
    """
    if refusal is None or says_why(text, refusal):
        return ""
    return describe_refusal(refusal) + "\n"


def with_refusal(text: str, refusal: Refusal | None) -> str:
    """Append the refusal's reason as one more line after the shell's
    own output, for a surface that hands the agent text.

    Args:
        text (str): the joined stdout and stderr.
        refusal (Refusal | None): the record off the result; None
            returns the text unchanged.
    """
    line = refusal_line(text, refusal)
    if not line or not text:
        return text or line
    return text + line if text.endswith("\n") else f"{text}\n{line}"


def with_refusal_bytes(data: bytes, refusal: Refusal | None) -> bytes:
    """``with_refusal`` for a surface that hands the agent raw stderr
    bytes; the bytes themselves are never decoded.

    Args:
        data (bytes): the shell's stderr.
        refusal (Refusal | None): the record off the result; None
            returns the bytes unchanged.
    """
    line = refusal_line(decode(data), refusal).encode("utf-8")
    if not line or not data:
        return data or line
    return data + line if data.endswith(b"\n") else data + b"\n" + line


def io_to_str(io: IOResult) -> str:
    stdout = decode(io.stdout if isinstance(io.stdout, bytes) else None)
    stderr = decode(io.stderr if isinstance(io.stderr, bytes) else None)
    text = stdout
    if stderr:
        text = f"{stdout}\n{stderr}" if stdout else stderr
    return with_refusal(text, io.refusal)
