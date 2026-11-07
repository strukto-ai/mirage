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

from collections.abc import AsyncIterator, Callable

from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.stream import close_quietly
from mirage.types import PathSpec
from mirage.utils.quote import shell_quote, shell_quote_always


class RandomSourceError(Exception):
    """A ``--random-source`` file that could not hand out the bytes asked
    for, worded as the command says it, without the trailing newline."""


class RandomSource:
    """The bytes a ``--random-source`` file hands out, in order, read only
    as they are asked for, so a file nothing draws from is never opened.

    Args:
        cmd (str): the command, which prefixes every refusal.
        path (PathSpec): the file.
        stream (Callable[[PathSpec], AsyncIterator[bytes]]): its reader.
        opening (str | None): the step a refused open is named by
            (``open failed``), or None to name the file alone.
    """

    def __init__(
        self,
        cmd: str,
        path: PathSpec,
        stream: Callable[[PathSpec], AsyncIterator[bytes]],
        opening: str | None = None,
    ) -> None:
        self.cmd = cmd
        self.path = path
        self.stream = stream
        self.opening = opening
        self.chunks: AsyncIterator[bytes] | None = None
        self.held = bytearray()

    @property
    def label(self) -> str:
        return (
            self.path.raw_path
            if self.path.raw_path is not None
            else self.path.virtual
        )

    async def take(self, count: int) -> bytes:
        """The next ``count`` bytes.

        Args:
            count (int): how many.

        Raises:
            RandomSourceError: the file could not be opened or read, or
                ended first.
        """
        if self.chunks is None:
            self.chunks = aiter(self.stream(self.path))
        while len(self.held) < count:
            try:
                chunk = await anext(self.chunks)
            except StopAsyncIteration:
                raise RandomSourceError(
                    f"{self.cmd}: {shell_quote_always(self.label)}: "
                    "end of file"
                ) from None
            except IsADirectoryError as exc:
                raise RandomSourceError(
                    f"{self.cmd}: {shell_quote_always(self.label)}: "
                    f"read error: {fs_strerror(exc)}"
                ) from exc
            except FS_ERRORS as exc:
                step = "" if self.opening is None else f"{self.opening}: "
                raise RandomSourceError(
                    f"{self.cmd}: {step}{shell_quote(self.label)}: "
                    f"{fs_strerror(exc)}"
                ) from exc
            self.held += chunk
        taken = bytes(self.held[:count])
        del self.held[:count]
        return taken

    async def close(self) -> None:
        if self.chunks is not None:
            await close_quietly(self.chunks)


__all__ = ["RandomSource", "RandomSourceError"]
