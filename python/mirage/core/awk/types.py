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

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class CommandRun:
    """What one shell command line left behind once it finished.

    Args:
        stdout (bytes): everything it wrote to standard output.
        stderr (bytes): everything it wrote to standard error.
        status (int): its exit status.
    """

    stdout: bytes
    stderr: bytes
    status: int


class AwkHost(Protocol):
    """The entry points an awk program reaches the world through.

    Every stream awk opens by name goes through here: the main input
    operands, ``getline < file``, output redirection and the command
    pipes. A failure to open, read or write raises ``AwkIOError``.
    """

    def open_input(self, name: str, index: int | None) -> AsyncIterator[bytes]:
        """Open an input stream by name.

        Args:
            name (str): the file name, ``-`` or ``/dev/stdin`` for stdin.
            index (int | None): the ARGV slot the name was read from, so
                an operand still holding its command-line value reads
                the file the command line named; None for getline.
        """
        ...

    async def write_file(self, name: str, body: str, append: bool) -> None:
        """Write output text to a named file.

        Args:
            name (str): the file name as the program spelled it.
            body (str): the text to write.
            append (bool): append rather than replace the file.
        """
        ...

    async def run(self, command: str, stdin: bytes | None) -> CommandRun:
        """Run one shell command line to completion.

        Args:
            command (str): the line, as ``sh -c`` would take it.
            stdin (bytes | None): its standard input; None hands it awk's
                own, still unread.
        """
        ...


__all__ = ["AwkHost", "CommandRun"]
