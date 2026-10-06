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

from mirage.workspace.workspace import Workspace

MIRAGE_SYSTEM_PROMPT = """\
Your filesystem is powered by Mirage — a virtual filesystem that mounts \
cloud storage, local files, and in-memory data as a unified file tree.

Capabilities beyond standard filesystem:
- head -n 5 on data files returns the first 5 rows
- grep works on structured text such as CSV and JSON, not just plain text
- Pipes work: cat data.csv | grep error | sort | uniq | wc -l
- head, tail, cut, wc, sort, uniq, tee, xargs are all available
- Start a recursive grep or rg inside the mount you mean, not at /: \
a mount searches with its own index only when the search starts inside it

You can write Python code and execute it. The workspace is pre-configured \
with your data sources mounted at their respective paths.

Use the shell tool for complex operations. \
Use read/write/edit for simple file operations.
"""


async def build_system_prompt(
    mount_info: dict[str, str] | None = None,
    extra_instructions: str = "",
    workspace: Workspace | None = None,
    session_id: str | None = None,
) -> str:
    """Build a system prompt with optional mount info and extra instructions.

    Args:
        mount_info (dict[str, str] | None): Map of mount prefix to description.
        extra_instructions (str): Additional instructions to append.
        workspace (Workspace | None): If provided, generates the current
            session's VFS Markdown.
        session_id (str | None): The workspace session described to the agent.

    Returns:
        str: The complete system prompt.
    """
    parts = [MIRAGE_SYSTEM_PROMPT]
    if workspace is not None:
        parts.append(
            "Mounted data sources:\n"
            + await workspace.vfs_md(session_id=session_id)
        )
    elif mount_info:
        parts.append("\nMounted data sources:")
        for prefix, description in mount_info.items():
            parts.append(f"- {prefix} — {description}")
        parts.append("")
    if extra_instructions:
        parts.append(extra_instructions)
    return "\n".join(parts)
