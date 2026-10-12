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

from mirage.shell.bytes import encode_text
from mirage.shell.helpers import get_text
from mirage.shell.types import TSNodeLike
from mirage.workspace.evaluation import EvaluationContext


def diagnostic_stderr(node: TSNodeLike, context: EvaluationContext) -> bytes:
    if not context.frame.diagnostics:
        return b""
    head = get_text(node).split(None, 1)[0]
    builtin = (
        head
        if head
        in {"export", "declare", "local", "readonly", "read", "printf", "let"}
        else ""
    )
    prefix = f"bash: {builtin}: " if builtin else "bash: "
    return b"".join(
        message
        if isinstance(message, bytes)
        else encode_text(prefix + message + "\n")
        for message in context.frame.diagnostics
    )
