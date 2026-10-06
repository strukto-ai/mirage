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

import asyncio
import logging
from collections import deque
from collections.abc import Awaitable, Callable
from enum import Enum

import asyncssh
from asyncssh.editor import SSHLineEditorChannel

from mirage.io.cooperative import chunks
from mirage.io.types import IOResult
from mirage.server.ssh.constants import REFUSAL_WINDOW
from mirage.shell.bytes import decode_text, encode_text
from mirage.workspace.tools.io_text import refusal_line

logger = logging.getLogger(__name__)

ENCODING = "utf-8"
# asyncssh runs its line editor only on a text channel, and
# surrogateescape is the one error policy under which every byte
# survives the str round trip, so binary input and output cross a text
# channel unchanged.
ERRORS = "surrogateescape"
READ_SIZE = 64 * 1024
# How far the client may type or pipe ahead of whoever reads it before
# the channel stops being read and SSH flow control pushes back.
MAX_BUFFERED = 1024 * 1024
MAX_LINE = 1024 * 1024
MAX_TERMINAL_LINE = 1024

TAB = 0x09
LF = 0x0A
CR = 0x0D
BS = 0x08
BEL = 0x07
DEL = 0x7F
ETX = 0x03
EOT = 0x04
NAK = 0x15
ESC = 0x1B
CSI_START = 0x5B
SS3_START = 0x4F
ERASE = b"\b \b"
NEWLINE = b"\r\n"

Send = Callable[[bytes, bool], Awaitable[None]]


class Mark(Enum):
    """A control or input limit delivered in band with channel input."""

    EOF = "eof"
    INTERRUPT = "interrupt"
    LIMIT = "limit"


class _EscapeState(Enum):
    NONE = "none"
    START = "start"
    CSI = "csi"
    SS3 = "ss3"


def edited(process: asyncssh.SSHServerProcess[str]) -> bool:
    """Whether asyncssh's line editor runs on the channel.

    It runs only for a pty with a terminal type; a pty requested
    without one (the client's ``TERM`` unset) gets ``LineDiscipline``.

    Args:
        process (asyncssh.SSHServerProcess[str]): the channel's process.

    Returns:
        bool: True when asyncssh edits the channel's input.
    """
    return bool(process.term_type)


class LineDiscipline:
    """The cooked-mode line discipline a pty gives a shell.

    Echo, erase (Backspace, Ctrl-U), Enter, Ctrl-C and Ctrl-D, with
    escape sequences such as arrow keys swallowed. asyncssh's line
    editor does this for a pty with a terminal type; a pty without one
    gets this small one, the one the TypeScript server always uses.

    Args:
        echo (Callable[[bytes], None]): writes the echo to the client.
        line (Callable[[bytes], None]): takes each entered line, with
            its newline.
        interrupt (Callable[[], None]): called for Ctrl-C.
        eof (Callable[[], None]): called for Ctrl-D on an empty line.
    """

    def __init__(
        self,
        echo: Callable[[bytes], None],
        line: Callable[[bytes], None],
        interrupt: Callable[[], None],
        eof: Callable[[], None],
    ) -> None:
        self._echo = echo
        self._take_line = line
        self._interrupt = interrupt
        self._eof = eof
        self._line = bytearray()
        self._echoed = bytearray()
        self._escape = _EscapeState.NONE
        self._after_cr = False

    def feed(self, chunk: bytes) -> None:
        """Take bytes the client typed, then echo what they showed.

        Args:
            chunk (bytes): the input.
        """
        for b in chunk:
            self._byte(b)
        if self._echoed:
            data = bytes(self._echoed)
            self._echoed.clear()
            self._echo(data)

    def _byte(self, b: int) -> None:
        was_cr = self._after_cr
        self._after_cr = False
        if self._escape is not _EscapeState.NONE:
            self._skip_escape(b)
        elif b == CR:
            self._enter()
            self._after_cr = True
        elif b == LF:
            if not was_cr:
                self._enter()
        elif b in (BS, DEL):
            self._erase()
        elif b == NAK:
            while self._line:
                self._erase()
        elif b == ETX:
            self._line.clear()
            self._interrupt()
        elif b == EOT:
            if not self._line:
                self._eof()
        elif b == ESC:
            self._escape = _EscapeState.START
        elif b < 0x20 and b != TAB:
            return
        elif len(self._line) >= MAX_TERMINAL_LINE:
            self._echoed.append(BEL)
        else:
            self._line.append(b)
            self._echoed.append(b)

    def _enter(self) -> None:
        self._echoed += NEWLINE
        self._line.append(LF)
        data = bytes(self._line)
        self._line.clear()
        self._take_line(data)

    def _erase(self) -> None:
        if not self._line:
            return
        while len(self._line) > 1 and self._line[-1] & 0xC0 == 0x80:
            self._line.pop()
        self._line.pop()
        self._echoed += ERASE

    def _skip_escape(self, b: int) -> None:
        if self._escape is _EscapeState.START:
            self._escape = (
                _EscapeState.CSI
                if b == CSI_START
                else _EscapeState.SS3
                if b == SS3_START
                else _EscapeState.NONE
            )
        elif self._escape is _EscapeState.SS3 or 0x40 <= b <= 0x7E:
            self._escape = _EscapeState.NONE


def encode(text: str) -> bytes:
    return text.encode(ENCODING, ERRORS)


def decode(data: bytes) -> str:
    return data.decode(ENCODING, ERRORS)


class ChannelInput:
    """Everything the client sends on one channel, read once, in order.

    One pump task reads the channel into a buffer, so the prompt and the
    running line's stdin draw from a single ordered stream (typeahead
    survives a command that did not read it), and an interrupt is seen
    even while nothing is reading. Ctrl-D from the line editor ends
    input for one reader, as a terminal's does; the channel's own EOF
    ends it for good. A pty asyncssh does not edit is cooked by a
    ``LineDiscipline`` here.

    Args:
        process (asyncssh.SSHServerProcess[str]): the channel's process.
        max_line (int | None): the longest line ``readline`` returns
            before it answers ``Mark.LIMIT``; None for ``MAX_LINE``.
    """

    def __init__(
        self,
        process: asyncssh.SSHServerProcess[str],
        max_line: int | None = None,
    ) -> None:
        self._process = process
        self._max_line = MAX_LINE if max_line is None else max_line
        self._items: deque[bytes | Mark] = deque()
        self._buffered = 0
        self._closed = False
        self._changed = asyncio.Event()
        self._room = asyncio.Event()
        self._room.set()
        self._interrupt: Callable[[], None] | None = None
        self._task: asyncio.Task[None] | None = None
        self._discipline = (
            LineDiscipline(
                self._echo,
                self._push,
                self._interrupted,
                lambda: self._push(Mark.EOF),
            )
            if process.term_type is not None and not edited(process)
            else None
        )

    def start(self) -> None:
        self._task = asyncio.create_task(self._pump())

    async def close(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        await asyncio.wait([self._task])
        if not self._task.cancelled() and self._task.exception():
            logger.warning(
                "ssh: input pump failed: %r", self._task.exception()
            )

    def on_interrupt(self, handler: Callable[[], None] | None) -> None:
        """Route Ctrl-C (a break) or an INT signal to ``handler``.

        With no handler, the interrupt is queued in band for the prompt
        to read, and the line editor's half-typed input is dropped.

        Args:
            handler (Callable[[], None] | None): called on the channel's
                loop for each interrupt, or None to queue them.
        """
        self._interrupt = handler

    async def _pump(self) -> None:
        stdin = self._process.stdin
        while True:
            await self._room.wait()
            try:
                data = await stdin.read(READ_SIZE)
            except (asyncssh.BreakReceived, asyncssh.SignalReceived):
                self._interrupted()
                continue
            except asyncssh.TerminalSizeChanged:
                continue
            except (asyncssh.Error, OSError) as exc:
                logger.debug("ssh: channel input ended: %r", exc)
                break
            if data and self._discipline is not None:
                self._discipline.feed(encode(data))
                await self._process.stdout.drain()
            elif data:
                self._push(encode(data))
            elif stdin.at_eof():
                break
            else:
                self._push(Mark.EOF)
        self._closed = True
        self._changed.set()

    def _echo(self, data: bytes) -> None:
        self._process.stdout.write(decode(data))

    def _interrupted(self) -> None:
        if self._interrupt is not None:
            self._interrupt()
            return
        chan = self._process.channel
        if edited(self._process) and isinstance(chan, SSHLineEditorChannel):
            chan.clear_input()
        self._push(Mark.INTERRUPT)

    def _push(self, item: bytes | Mark) -> None:
        self._items.append(item)
        self._buffered += len(item) if isinstance(item, bytes) else 1
        if self._buffered >= MAX_BUFFERED:
            self._room.clear()
        self._changed.set()

    def _took(self, size: int) -> None:
        self._buffered -= size
        if self._buffered < MAX_BUFFERED:
            self._room.set()

    async def _wait(self) -> None:
        self._changed.clear()
        await self._changed.wait()

    async def readline(self) -> bytes | Mark:
        """The next line, with its newline, or the control that came first.

        Returns:
            bytes | Mark: the line (a final unterminated one at the
                channel's EOF is returned as is), ``Mark.INTERRUPT`` for
                a Ctrl-C typed at the prompt, or ``Mark.EOF`` for Ctrl-D
                or the channel's EOF; ``Mark.LIMIT`` for an oversized line.
        """
        line = bytearray()
        while True:
            while self._items:
                item = self._items[0]
                if isinstance(item, Mark):
                    if line:
                        return bytes(line)
                    self._items.popleft()
                    self._took(1)
                    return item
                cut = item.find(b"\n")
                size = len(item) if cut < 0 else cut
                if len(line) + size > self._max_line:
                    return Mark.LIMIT
                if cut < 0:
                    self._items.popleft()
                    self._took(len(item))
                    line += item
                    continue
                self._took(cut + 1)
                line += item[: cut + 1]
                rest = item[cut + 1 :]
                if rest:
                    self._items[0] = rest
                else:
                    self._items.popleft()
                return bytes(line)
            if self._closed:
                return bytes(line) if line else Mark.EOF
            await self._wait()

    async def read(self) -> bytes:
        """The next buffered chunk, for a running line's stdin.

        Returns:
            bytes: the chunk, or ``b""`` at Ctrl-D or the channel's EOF.
        """
        while True:
            if self._items:
                item = self._items.popleft()
                if isinstance(item, Mark):
                    self._took(1)
                if item is Mark.EOF:
                    return b""
                if isinstance(item, bytes):
                    self._took(len(item))
                    return item
                continue
            if self._closed:
                return b""
            await self._wait()


class ChannelOutput:
    """Writes a line's output back to the client.

    On a terminal stderr folds into stdout, as a pty points both
    descriptors at one device; asyncssh's line editor then turns each
    newline into CRLF and redraws the input line around the output,
    and on a pty it does not edit, each newline goes out as CRLF here.

    Args:
        process (asyncssh.SSHServerProcess[str]): the channel's process.
        tty (bool): whether the client asked for a terminal.
    """

    def __init__(
        self, process: asyncssh.SSHServerProcess[str], tty: bool
    ) -> None:
        self._process = process
        self._tty = tty
        self._crlf = tty and not edited(process)

    async def write(self, data: bytes, stderr: bool = False) -> None:
        stream = (
            self._process.stderr
            if stderr and not self._tty
            else self._process.stdout
        )
        if self._crlf:
            data = data.replace(b"\n", b"\r\n")
        stream.write(decode(data))
        await stream.drain()


def loop_sender(
    output: ChannelOutput, loop: asyncio.AbstractEventLoop
) -> Send:
    """A writer the workspace loop can await, landing on the channel's loop.

    Awaiting it waits for the channel to drain, so a fast producer is
    paced by the client instead of buffered without bound.

    Args:
        output (ChannelOutput): the channel's output.
        loop (asyncio.AbstractEventLoop): the loop the channel lives on.

    Returns:
        Send: ``send(data, stderr)``.
    """

    async def send(data: bytes, stderr: bool) -> None:
        await asyncio.wrap_future(
            asyncio.run_coroutine_threadsafe(output.write(data, stderr), loop)
        )

    return send


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


async def deliver(io: IOResult, send: Send) -> None:
    """Stream a line's stdout, then its stderr, through ``send``, then
    the refusal's line on stderr when a policy refused part of it.

    The terminal's output goes out as the line printed it; the policy's
    reason is the one line ``refusal_line`` appends, read once both
    streams are drained, since an op a streaming command reads late is
    refused only then. Whether the output already says why is read off
    each stream's first and last ``REFUSAL_WINDOW`` bytes: the first runs
    on to the end of the line it cuts (at most a window more) and keeps
    whole lines only, so a line split at a cut can neither pose as the
    diagnostic nor hide one. A diagnostic deep inside a long output may
    be missed, which repeats the reason and never drops it.

    Args:
        io (IOResult): the line's result.
        send (Send): where each chunk goes.
    """
    said: list[bytes] = []
    for source, is_stderr in ((io.stdout, False), (io.stderr, True)):
        if source is None:
            continue
        prefix = tail = b""
        total = 0
        async for chunk in chunks(source):
            if chunk:
                total += len(chunk)
                if len(prefix) < 2 * REFUSAL_WINDOW:
                    prefix += chunk[: 2 * REFUSAL_WINDOW - len(prefix)]
                tail = (tail + chunk[-REFUSAL_WINDOW:])[-REFUSAL_WINDOW:]
                await send(chunk, is_stderr)
        said += [head_window(prefix, total), tail]
    line = refusal_line(decode_text(b"\n".join(said)), io.refusal)
    if line:
        await send(encode_text(line), True)
