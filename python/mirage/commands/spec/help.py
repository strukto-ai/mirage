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

from mirage.commands.spec.constants import ARG_PLACEHOLDER
from mirage.commands.spec.types import CommandSpec, Operand, Option, UsageStyle

# (name, one-line help) rows a CLI group passes for its children.
SubcommandRows = Sequence[tuple[str, str]]


def option_metavar(opt: Option) -> str:
    """The bare name of an option's value, declared or derived.

    clap derives one from the long spelling when the author declares no
    ``value_name``: dashes to underscores, uppercased. Deriving it the
    same way means only the options that actually override it have to
    say so.

    Args:
        opt (Option): the value-taking option.
    """
    if opt.metavar is not None:
        return opt.metavar
    spelling = opt.long or opt.short or ""
    return spelling.lstrip("-").replace("-", "_").upper()


def operand_slot(operand: Operand, ellipsis: bool = False) -> str:
    """One operand's slot in a clap usage line.

    Required slots take angle brackets and optional ones square, which
    is the only thing clap's usage line says about arity besides the
    trailing ellipsis on a variadic.

    Args:
        operand (Operand): the slot.
        ellipsis (bool): whether the slot is variadic (a rest operand).
    """
    name = operand.name or ARG_PLACEHOLDER
    slot = f"<{name}>" if operand.required else f"[{name}]"
    return f"{slot}..." if ellipsis else slot


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


def usage_line(name: str, spec: CommandSpec, subcommands: SubcommandRows,
               style: UsageStyle) -> str:
    """The ``Usage:`` line, in the dialect the CLI declares.

    clap spells the option placeholder ``[OPTIONS]`` and the subcommand
    slot ``<COMMAND>``, and names each operand; the default spells them
    ``[flags]``, ``<command> [<args>]`` and a generic ``<path>``/
    ``<text>`` per slot.

    Args:
        name (str): command name as invoked.
        spec (CommandSpec): the node's grammar.
        subcommands (SubcommandRows): child rows, empty for a leaf.
        style (UsageStyle): the dialect.
    """
    clap = style is UsageStyle.CLAP
    bits = [name]
    if spec.options:
        bits.append("[OPTIONS]" if clap else "[flags]")
    if subcommands:
        bits.append("<COMMAND>" if clap else "<command> [<args>]")
    for operand in spec.positional:
        if clap:
            bits.append(operand_slot(operand))
        else:
            bits.append("<path>" if operand.type == "path" else "<text>")
    if spec.rest is not None:
        if clap:
            bits.append(operand_slot(spec.rest, ellipsis=True))
        elif spec.rest.type == "path":
            bits.append("[<path>...]")
        else:
            bits.append("[<text>...]")
    return "Usage: " + " ".join(bits)


def render_help(name: str,
                spec: CommandSpec,
                subcommands: SubcommandRows = (),
                style: UsageStyle = UsageStyle.ARGPARSE) -> str:
    """Render one command's help; a CLI group is the same shape plus a
    Commands section.

    Args:
        name (str): command name as invoked (a CLI group passes its full
            display path, e.g. "gws gmail").
        spec (CommandSpec): the node's grammar.
        subcommands (SubcommandRows): (name, one-line help)
            rows for a CLI group node; when given, the usage line reads
            ``<command> [<args>]`` instead of the operand slots.
        style (UsageStyle): whose help layout to render. clap heads the
            page with a bare description, calls the section ``Options:``
            and leaves subcommands in declaration order; every other
            style prefixes the description with the program path, calls
            the section ``Flags:`` and sorts.
    """
    clap = style is UsageStyle.CLAP
    lines: list[str] = []
    if not spec.description:
        lines.append(name)
    elif clap:
        lines.append(spec.description)
    else:
        lines.append(f"{name}: {spec.description}")
    lines.append("")

    lines.append(usage_line(name, spec, subcommands, style))

    if subcommands:
        lines.append("")
        lines.append("Commands:")
        width = max(len(sub) for sub, _ in subcommands)
        # clap prints subcommands in the order the program declares
        # them, which is a deliberate ordering by an author rather than
        # an alphabet, so re-sorting would lose information.
        sub_rows = subcommands if clap else sorted(subcommands)
        for sub, desc in sub_rows:
            first = desc.split("\n")[0]
            if first:
                lines.append(f"  {sub.ljust(width)}  {first}")
            else:
                lines.append(f"  {sub}")

    if spec.options:
        lines.append("")
        lines.append("Options:" if clap else "Flags:")
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


def clap_unexpected_argument(token: str) -> str:
    """clap's wording for a token it has no option for.

    One wording for long and short alike, unlike git's option/switch
    split, and it names the token as typed. Probed against ntn 0.21.9.

    Args:
        token (str): the offending token, dashes included.
    """
    return f"error: unexpected argument '{token}' found"


def clap_group_refusal(name: str, spec: CommandSpec,
                       subcommands: SubcommandRows, message: str) -> bytes:
    """A group-level refusal in clap's shape: message, usage, footer.

    clap answers with the one usage line, not the whole help page git
    prints, and it does so at every level of the tree. This lives beside
    the renderer rather than beside the leaf refusals because the walk
    calls it, and the walk cannot reach a module that imports the
    workspace.

    Args:
        name (str): display path walked so far, e.g. "ntn pages".
        spec (CommandSpec): the node as the renderer lists it.
        subcommands (SubcommandRows): child rows, which decide whether
            the usage line carries a ``<COMMAND>`` slot.
        message (str): the first line, already worded.
    """
    usage = usage_line(name, spec, subcommands, UsageStyle.CLAP)
    return (f"{message}\n\n{usage}\n\n"
            "For more information, try '--help'.\n").encode()
