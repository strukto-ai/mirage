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

from mirage.errors.fs import error_path, fs_strerror
from mirage.io.types import IOResult
from mirage.policy import PolicyDenied, describe_refusal, says_why
from mirage.policy.constants import REFUSAL_WINDOW
from mirage.types import Refusal


def decode(value: bytes | None) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", errors="replace")


def refusal_line(text: str, refusal: Refusal | None) -> str:
    """The one line a text surface appends for a refusal, newline
    included, or the empty string when there is nothing to add: no
    record, or a text that already says why (an operand-scoped
    denial's own line, wherever a redirect landed it). A command-scoped
    refusal's stderr is bash's bare ``Permission denied``, which never
    does.

    Args:
        text (str): what the surface is about to hand over.
        refusal (Refusal | None): the record off the result.
    """
    if refusal is None or says_why(text, refusal):
        return ""
    return describe_refusal(refusal) + "\n"


def head_window(prefix: bytes, total: int) -> bytes:
    """A stream's first ``REFUSAL_WINDOW`` bytes, then on to the end of
    the line that window cuts (at most a window more), whole lines only
    unless the stream ends inside them.

    Args:
        prefix (bytes): the stream's first ``2 * REFUSAL_WINDOW`` bytes.
        total (int): the stream's whole length.
    """
    if total <= REFUSAL_WINDOW:
        return prefix
    end = prefix.find(b"\n", REFUSAL_WINDOW - 1)
    if end != -1:
        return prefix[: end + 1]
    if total <= 2 * REFUSAL_WINDOW:
        return prefix
    return prefix[: prefix.rfind(b"\n", 0, REFUSAL_WINDOW) + 1]


class SaidWindow:
    """What a streamed line said, as far as its refusal's line needs.

    Each stream keeps its first and last ``REFUSAL_WINDOW`` bytes. The
    first runs on to the end of the line it cuts and keeps whole lines
    only, so a line split at a cut can neither pose as the diagnostic
    nor hide one. A diagnostic deep inside a long output may be missed,
    which repeats the reason and never drops it.
    """

    def __init__(self) -> None:
        self._prefix = [b"", b""]
        self._tail = [b"", b""]
        self._total = [0, 0]

    def add(self, data: bytes, stderr: bool) -> None:
        """Note bytes a stream sent.

        Args:
            data (bytes): the bytes.
            stderr (bool): whether they went to stderr.
        """
        stream = int(stderr)
        self._total[stream] += len(data)
        prefix = self._prefix[stream]
        if len(prefix) < 2 * REFUSAL_WINDOW:
            self._prefix[stream] = (
                prefix + data[: 2 * REFUSAL_WINDOW - len(prefix)]
            )
        self._tail[stream] = (self._tail[stream] + data[-REFUSAL_WINDOW:])[
            -REFUSAL_WINDOW:
        ]

    def refusal_line(self, refusal: Refusal | None) -> str:
        """The line to append after the output, as ``refusal_line``.

        Args:
            refusal (Refusal | None): the record off the result.
        """
        said = [
            part
            for stream in (0, 1)
            for part in (
                head_window(self._prefix[stream], self._total[stream]),
                self._tail[stream],
            )
        ]
        return refusal_line(decode(b"\n".join(said)), refusal)


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


def error_text(exc: Exception) -> str:
    """A tool's failure as the agent reads it: a filesystem error as
    ``<path>: <phrase>`` (a policy's refusal reads as ``Permission
    denied``), or the phrase alone when no path was stamped and the
    message adds nothing, anything else in its own words, then the
    refusal's line when a policy refused the op. Mirrors TS ``errorText``.

    Args:
        exc (Exception): the failure.
    """
    refusal = exc.refusal if isinstance(exc, PolicyDenied) else None
    strerror = fs_strerror(exc)
    if strerror is None:
        words = str(exc)
    elif isinstance(getattr(exc, "filename", None), str):
        words = f"{error_path(exc)}: {strerror}"
    elif str(exc) in ("", strerror) or (
        isinstance(exc, OSError) and exc.errno
    ):
        words = strerror
    else:
        words = f"{exc}: {strerror}"
    return with_refusal(f"Error: {words}", refusal)


def io_to_str(io: IOResult) -> str:
    stdout = decode(io.stdout if isinstance(io.stdout, bytes) else None)
    stderr = decode(io.stderr if isinstance(io.stderr, bytes) else None)
    text = stdout
    if stderr:
        text = f"{stdout}\n{stderr}" if stdout else stderr
    return with_refusal(text, io.refusal)


def replace_text(
    content: str, old: str, new: str, replace_all: bool
) -> tuple[str, int]:
    """The edit tools' one substitution: ``content`` with ``old``
    replaced once, or everywhere under ``replace_all``, beside how many
    times it occurs. A count other than one without ``replace_all`` is
    the caller's refusal to word.

    Args:
        content (str): the file's text.
        old (str): the text to find.
        new (str): the text to put in its place.
        replace_all (bool): True replaces every occurrence.
    """
    return content.replace(old, new, -1 if replace_all else 1), content.count(
        old
    )
