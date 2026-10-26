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

from collections.abc import Iterable

from mirage._rs import ShellTree


def parse_shell(source: str | bytes, aliases: Iterable[str] = ()) -> ShellTree:
    """Parse a shell program with mirage's own bash parser.

    The tree has tree-sitter-bash's node kinds, field names and byte and
    point spans, and bash's reading where that grammar misreads bash, so
    its root node walks as a ``TSNodeLike``.

    Args:
        source (str | bytes): the program; in text, a lone surrogate
            stands for the byte it escapes.
        aliases (Iterable[str]): the names the shell expands as aliases;
            one is a command where a command starts, never a reserved word.
    """
    if isinstance(source, str):
        source = source.encode("utf-8", "surrogateescape")
    return ShellTree(source, list(aliases))
