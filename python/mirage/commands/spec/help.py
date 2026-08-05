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

from collections.abc import Sequence

from mirage.commands.spec.types import CommandSpec, Option

# (name, one-line help) rows a CLI group passes for its children.
SubcommandRows = Sequence[tuple[str, str]]


def _value_label(opt: Option) -> str:
    if opt.type == "bool":
        return ""
    # A pair option takes two tokens, and the first one names the value.
    value = "<path>" if opt.type == "path" else "<text>"
    if opt.pair:
        return f" <name> {value}"
    return f" {value}"


def _flag_display(opt: Option) -> str:
    parts: list[str] = []
    if opt.short is not None:
        parts.append(opt.short)
    if opt.long is not None:
        parts.append(opt.long)
    return ", ".join(parts) + _value_label(opt)


def flag_rows(spec: CommandSpec) -> list[tuple[str, str]]:
    """Display rows (flag spelling, description) for a spec's options.

    Args:
        spec (CommandSpec): the spec whose options to render.
    """
    return [(_flag_display(o), o.description or "") for o in spec.options]


def render_help(name: str, spec: CommandSpec,
                subcommands: SubcommandRows = ()) -> str:
    """Render one command's help; a CLI group is the same shape plus a
    Commands section.

    Args:
        name (str): command name as invoked (a CLI group passes its full
            display path, e.g. "gws gmail").
        spec (CommandSpec): the node's grammar.
        subcommands (SubcommandRows): (name, one-line help)
            rows for a CLI group node; when given, the usage line reads
            ``<command> [<args>]`` instead of the operand slots.
    """
    lines: list[str] = []
    if spec.description:
        lines.append(f"{name}: {spec.description}")
    else:
        lines.append(name)
    lines.append("")

    usage_bits = [name]
    if spec.options:
        usage_bits.append("[flags]")
    if subcommands:
        usage_bits.append("<command> [<args>]")
    for op in spec.positional:
        usage_bits.append("<path>" if op.type == "path" else "<text>")
    if spec.rest is not None:
        kind = spec.rest.type
        usage_bits.append("[<path>...]" if kind == "path" else "[<text>...]")
    lines.append("Usage: " + " ".join(usage_bits))

    if subcommands:
        lines.append("")
        lines.append("Commands:")
        width = max(len(sub) for sub, _ in subcommands)
        for sub, desc in sorted(subcommands):
            first = desc.split("\n")[0]
            if first:
                lines.append(f"  {sub.ljust(width)}  {first}")
            else:
                lines.append(f"  {sub}")

    if spec.options:
        lines.append("")
        lines.append("Flags:")
        rows = flag_rows(spec)
        width = max(len(flag) for flag, _ in rows)
        for flag, desc in rows:
            if desc == "":
                lines.append(f"  {flag}")
            else:
                lines.append(f"  {flag.ljust(width)}  {desc}")

    if spec.epilog:
        lines.append("")
        lines.append(spec.epilog.rstrip("\n"))

    return "\n".join(lines) + "\n"
