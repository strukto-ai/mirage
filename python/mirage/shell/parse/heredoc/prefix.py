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

from dataclasses import replace

from mirage.shell.parse.heredoc.body import heredoc_bodies
from mirage.shell.parse.heredoc.constants import (HEREDOC_BODY, HEREDOC_START,
                                                  SKIPPED_BLANKS)
from mirage.shell.parse.heredoc.shield import heredoc_operators
from mirage.shell.types import TSNodeLike


def tree_root(node: TSNodeLike) -> TSNodeLike:
    """The root of the tree ``node`` belongs to.

    Args:
        node (TSNodeLike): any node of the tree.
    """
    while node.parent is not None:
        node = node.parent
    return node


def body_prefix(redirect_node: TSNodeLike) -> str:
    """The opening bytes of a body that tree-sitter left out of its node.

    The scanner starts heredoc_body at the first byte it keeps, dropping
    every empty line before it and, when the shield could not run, the
    first kept line's indentation; bash keeps all of that. Where bash
    starts the body is what heredoc_bodies says over the whole tree, so
    a later heredoc on the same operator line is measured from the line
    after the earlier body's terminator rather than from the newline
    the two operators share, innermost-first, which is the order the
    parser's source keeps a line's bodies in (see relayout). What lies
    between that start and the body node is exactly the dropped run when
    it is blank, and is body text nowhere else, so a gap holding anything
    but blanks and newlines yields nothing. The tree's text begins at its
    root, which sits past any blanks before the first token, so offsets
    are taken from there.

    Args:
        redirect_node (TSNodeLike): a heredoc_redirect node.

    Returns:
        str: the dropped prefix, empty when the node starts where bash
        starts the body.
    """
    start = body = None
    for child in redirect_node.children:
        if child.type == HEREDOC_START:
            start = child
        elif child.type == HEREDOC_BODY:
            body = child
    if start is None or body is None:
        return ""
    root = tree_root(redirect_node)
    origin = root.start_byte
    data = root.text or b""
    operators = [
        replace(operator,
                word_start=operator.word_start - origin,
                word_end=operator.word_end - origin)
        for operator in heredoc_operators(root)
    ]
    word_start = start.start_byte - origin
    spans = heredoc_bodies(data, operators, nested=True)
    span = next((span for operator, span in zip(operators, spans)
                 if operator.word_start == word_start), None)
    if span is None:
        return ""
    gap = data[span[0]:body.start_byte - origin]
    if not gap or any(byte not in SKIPPED_BLANKS for byte in gap):
        return ""
    return gap.decode()
