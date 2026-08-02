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

from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.help import flag_rows


def render_group_help(name: str, node: CLISpec) -> str:
    """Render a group node's help: usage line, commands, own flags.

    Follows git's shape (`git` with no verb prints a usage block naming
    the subcommands); the same text serves `--help` (stdout, exit 0) and
    the bare-group refusal (stdout, exit 1, matching git).

    Args:
        name (str): full display path as typed, e.g. "gws gmail"; the
            head word is the installed name, so a renamed install
            renders its own spelling.
        node (CLISpec): the group node.
    """
    lines: list[str] = []
    usage_bits = [f"usage: {name}"]
    if node.options:
        usage_bits.append("[<options>]")
    usage_bits.append("<command> [<args>]")
    lines.append(" ".join(usage_bits))
    if node.description:
        lines.append("")
        lines.append(node.description)
    lines.append("")
    lines.append("Commands:")
    width = max(len(child.name) for child in node.subcommands)
    for child in sorted(node.subcommands, key=lambda c: c.name):
        desc = (child.description or "").split("\n")[0]
        if desc:
            lines.append(f"  {child.name.ljust(width)}  {desc}")
        else:
            lines.append(f"  {child.name}")
    if node.options:
        lines.append("")
        lines.append("Flags:")
        rows = flag_rows(node)
        width = max(len(flag) for flag, _ in rows)
        for flag, desc in rows:
            if desc == "":
                lines.append(f"  {flag}")
            else:
                lines.append(f"  {flag.ljust(width)}  {desc}")
    return "\n".join(lines) + "\n"
