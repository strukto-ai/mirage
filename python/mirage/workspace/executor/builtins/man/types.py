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

# A paragraph, or a tagged paragraph: a word set off at the margin
# (an option, a subcommand) and the text that explains it.
ManBlock = str | tuple[str, str]

# A heading after NAME and the blocks under it.
ManSection = tuple[str, tuple[ManBlock, ...]]


@dataclass(frozen=True, slots=True)
class ManPage:
    """One page of the manual, before it is laid out to a width.

    Every page is in section 1, whatever documents it: a builtin's
    help topic, a mounted command's spec, or a node of an installed CLI.

    Args:
        name (str): the page, as ``man`` and ``man -f`` name it
            (``git-commit`` for a CLI's subcommand).
        summary (str): the line after the name in NAME; empty when the
            source carries none.
        sections (tuple[ManSection, ...]): each heading after NAME and
            the blocks under it.
    """

    name: str
    summary: str
    sections: tuple[ManSection, ...]
