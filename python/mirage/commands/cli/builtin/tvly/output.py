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

# `-o` naming and saving adapted from tvly 1.0.2's src/ui/render/emit.ts
# (MIT; see licenses/third_party/tavily-cli.txt).

import posixpath
import re
from dataclasses import dataclass, field
from datetime import datetime

from mirage.commands.cli.operand import ensure_dir
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import MISS_ERRORS
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.utils.clock import system_now

DEFAULT_OUTPUT_DIR = ".tavily"
WORD = re.compile(r"[a-z0-9]+")


@dataclass
class Streams:
    """The stdout and stderr one tvly verb writes, gathered in order.

    Args:
        stdout (list[str]): stdout text.
        stderr (list[str]): stderr text.
    """

    stdout: list[str] = field(default_factory=list)
    stderr: list[str] = field(default_factory=list)

    def out(self, line: str = "") -> None:
        self.stdout.append(line + "\n")

    def err(self, line: str = "") -> None:
        self.stderr.append(line + "\n")

    def result(self, exit_code: int = 0) -> tuple[bytes, IOResult]:
        """The gathered text as a command's answer.

        Args:
            exit_code (int): the status to exit with.
        """
        stderr = "".join(self.stderr).encode()
        return "".join(self.stdout).encode(), IOResult(
            stderr=stderr or None, exit_code=exit_code
        )


def output_slug(label: str) -> str:
    """The label as lower-case words joined by dashes, at most 40 long.

    Args:
        label (str): what the call was about (query, host, request id).
    """
    slug = "-".join(WORD.findall(label.lower()))[:40].strip("-")
    return slug or "result"


def resolve_output(
    fl: FlagView, ctx: Context, command: str, label: str
) -> PathSpec | None:
    """The file ``-o`` names: as given, or for a bare ``-o`` a fresh one
    under ``.tavily/``; None without ``-o``.

    Args:
        fl (FlagView): the line's flags.
        ctx (Context): the invocation context.
        command (str): the verb, the name's first word.
        label (str): what the call was about.
    """
    value = fl.raw("output")
    if isinstance(value, PathSpec):
        return value
    if value is not True:
        return None
    now = datetime.fromtimestamp(system_now())
    name = (
        f"{command}-{output_slug(label)}-{now:%H%M%S}-"
        f"{ctx.ids.secure_bytes(3).hex()}.json"
    )
    return PathSpec.from_str_path(
        posixpath.join(DEFAULT_OUTPUT_DIR, name), cwd=ctx.cwd
    )


async def emit(
    streams: Streams, ctx: Context, text: str, output: PathSpec | None
) -> None:
    """Print JSON text, or save it to ``output``.

    A folder the save creates is made whole, and one named ``.tavily``
    gets a ``.gitignore`` of ``*`` so saved results stay out of git.

    Args:
        streams (Streams): where the verb's output gathers.
        ctx (Context): the invocation context.
        text (str): the JSON text.
        output (PathSpec | None): the file to save to; None prints.
    """
    if output is None:
        streams.out(text)
        return
    if ctx.vfs is None:
        raise RuntimeError("no workspace files")
    folder = output.parent
    try:
        await ctx.vfs.stat(folder)
    except MISS_ERRORS:
        await ensure_dir(ctx.vfs, folder)
        if posixpath.basename(folder.virtual) == DEFAULT_OUTPUT_DIR:
            await ctx.vfs.write(folder.join(".gitignore"), b"*\n")
    await ctx.vfs.write(output, (text + "\n").encode())
    streams.err(f"Output saved to {output.raw_path}")


def json_requested(fl: FlagView, output: PathSpec | None) -> bool:
    """Whether the verb answers with its JSON rather than its text.

    Args:
        fl (FlagView): the line's flags.
        output (PathSpec | None): the ``-o`` file.
    """
    return fl.as_bool("json") or output is not None
