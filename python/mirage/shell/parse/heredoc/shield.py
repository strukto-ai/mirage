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

from mirage.shell.bytes import decode_text
from mirage.shell.parse.heredoc.constants import DASH_ARROW, HEREDOC_START
from mirage.shell.parse.heredoc.delimiter import clean_delimiter
from mirage.shell.parse.heredoc.types import HeredocOperator
from mirage.shell.parse.names import walk_tree
from mirage.shell.types import TSNodeLike


def heredoc_operators(root: TSNodeLike) -> list[HeredocOperator]:
    """Every heredoc operator under ``root``, in source order.

    ERROR subtrees are walked too: a body the lexer mangled badly enough
    leaves no heredoc_redirect behind, but its start token survives.
    These are hints; the source reader validates delimiter word bounds.

    Args:
        root (TSNodeLike): the parsed tree.
    """
    found: list[HeredocOperator] = []
    for node in walk_tree(root):
        if node.type != HEREDOC_START:
            continue
        delimiter = clean_delimiter(decode_text(node.text or b""))
        previous = node.prev_sibling
        found.append(
            HeredocOperator(
                word_start=node.start_byte,
                word_end=node.end_byte,
                delimiter=delimiter,
                allows_indent=previous is not None
                and previous.type == DASH_ARROW,
            )
        )
    found.sort(key=lambda operator: operator.word_start)
    return found
