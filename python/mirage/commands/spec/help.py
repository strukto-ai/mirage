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

from mirage.commands.spec.types import CommandSpec, OperandKind, Option

_VALUE_LABEL = {
    OperandKind.NONE: "",
    OperandKind.PATH: " <path>",
    OperandKind.TEXT: " <text>",
}


def _flag_display(opt: Option) -> str:
    parts: list[str] = []
    if opt.short is not None:
        parts.append(opt.short)
    if opt.long is not None:
        parts.append(opt.long)
    return ", ".join(parts) + _VALUE_LABEL[opt.value_kind]


def render_help(name: str, spec: CommandSpec) -> str:
    lines: list[str] = []
    if spec.description:
        lines.append(f"{name}: {spec.description}")
    else:
        lines.append(name)
    lines.append("")

    usage_bits = [name]
    if spec.options:
        usage_bits.append("[flags]")
    for op in spec.positional:
        usage_bits.append("<path>" if op.kind ==
                          OperandKind.PATH else "<text>")
    if spec.rest is not None:
        kind = spec.rest.kind
        usage_bits.append("[<path>...]" if kind ==
                          OperandKind.PATH else "[<text>...]")
    lines.append("Usage: " + " ".join(usage_bits))

    if spec.options:
        lines.append("")
        lines.append("Flags:")
        rows = [(_flag_display(o), o.description or "") for o in spec.options]
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
