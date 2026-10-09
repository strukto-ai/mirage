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

from mirage.commands.spec.compile import (
    argument_dest,
    compile_spec,
    option_spellings,
    positional_name,
    positional_required,
)
from mirage.commands.spec.constants import ARG_PLACEHOLDER
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle

# (name, one-line help) rows a CLI group passes for its children.
SubcommandRows = Sequence[tuple[str, str]]


def option_metavar(opt: Argument) -> str:
    """The bare name of an option's value, declared or derived.

    clap derives one from the long spelling when the author declares no
    ``value_name``: dashes to underscores, uppercased. Deriving it the
    same way means only the options that actually override it have to
    say so.

    Args:
        opt (Argument): the value-taking option.
    """
    if opt.metavar is not None:
        return opt.metavar
    spelling = argument_dest(opt)
    return spelling.lstrip("-").replace("-", "_").upper()


def operand_slot(operand: Argument, ellipsis: bool = False) -> str:
    """One operand's slot in a clap usage line.

    Required slots take angle brackets and optional ones square, which
    is the only thing clap's usage line says about arity besides the
    trailing ellipsis on a variadic.

    Args:
        operand (Argument): the slot.
        ellipsis (bool): whether the slot is variadic (a rest operand).
    """
    name = positional_name(operand) or ARG_PLACEHOLDER
    slot = f"<{name}>" if positional_required(operand) else f"[{name}]"
    return f"{slot}..." if ellipsis else slot


def _value_label(opt: Argument) -> str:
    if opt.action in ("store_true", "count"):
        return ""
    kind = "path" if opt.type == "path" else "text"
    value = f"<{opt.metavar if opt.metavar is not None else kind}>"
    if opt.value_types:
        return f" <name> {value}"
    if isinstance(opt.nargs, int):
        return f" {value}" * opt.nargs
    return f" {value}"


def _flag_display(opt: Argument) -> str:
    return ", ".join(opt.names) + _value_label(opt)


def flag_rows(spec: CommandSpec) -> list[tuple[str, str]]:
    """Display rows (flag spelling, description) for a spec's options.

    Args:
        spec (CommandSpec): the spec whose options to render.
    """
    return [
        (_flag_display(o), o.help or "") for o in compile_spec(spec).options
    ]


def _slot(operand: Argument) -> str:
    """One operand's placeholder outside the clap dialect.

    A spec that named the slot gets that name, which is what argparse
    prints too (it renders the dest, not a generic word); a spec that did
    not falls back to the type. Only `gh` names one outside clap today, so
    this is the difference between `gh api [flags] <text>` and upstream's
    `gh api <endpoint>`.

    Args:
        operand (Argument): the slot to render.

    Returns:
        str: the bracketed placeholder.
    """
    if positional_name(operand):
        return f"<{positional_name(operand)}>"
    return "<path>" if operand.type == "path" else "<text>"


def usage_line(
    name: str,
    spec: CommandSpec,
    subcommands: SubcommandRows,
    style: UsageStyle,
    synopsis: str | None = None,
) -> str:
    """The ``Usage:`` line, in the dialect the CLI declares.

    A ``synopsis`` (the imitated program's own ``--help`` first line,
    handed in by the registration that knows the spec is the builtin's)
    is printed as is, whatever the dialect.

    Args:
        name (str): command name as invoked.
        spec (CommandSpec): the node's grammar.
        subcommands (SubcommandRows): child rows, empty for a leaf.
        style (UsageStyle): the dialect.
    """
    if synopsis is not None:
        # The builtin that mimics a real program answers with that
        # program's own first line rather than one synthesized from
        # its slots.
        return "Usage: " + synopsis
    compiled = compile_spec(spec)
    clap = style is UsageStyle.CLAP
    bits = [name]
    if compiled.options:
        bits.append("[OPTIONS]" if clap else "[flags]")
    if subcommands:
        bits.append("<COMMAND>" if clap else "<command> [<args>]")
    for operand in compiled.positional:
        if clap:
            bits.append(operand_slot(operand))
        else:
            bits.append(_slot(operand))
    if compiled.rest is not None:
        if clap:
            bits.append(operand_slot(compiled.rest, ellipsis=True))
        else:
            bits.append(f"[{_slot(compiled.rest)}...]")
    return "Usage: " + " ".join(bits)


def render_help(
    name: str,
    spec: CommandSpec,
    subcommands: SubcommandRows = (),
    style: UsageStyle = UsageStyle.ARGPARSE,
    synopsis: str | None = None,
) -> str:
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
        synopsis (str | None): the imitated program's own ``--help``
            first line, printed in place of the synthesized one.
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

    lines.append(usage_line(name, spec, subcommands, style, synopsis))

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

    if compile_spec(spec).options:
        lines.append("")
        lines.append("Options:" if clap else "Flags:")
        rows = flag_rows(spec)
        width = max(len(flag) for flag, _ in rows)
        for flag, desc in rows:
            if desc == "":
                lines.append(f"  {flag}")
            else:
                lines.append(f"  {flag.ljust(width)}  {desc}")

    operands = [
        argument
        for argument in spec.arguments
        if not argument.names[0].startswith("-") and argument.help
    ]
    if operands:
        lines.extend(["", "Arguments:"])
        width = max(len(_slot(operand)) for operand in operands)
        for operand in operands:
            lines.append(f"  {_slot(operand).ljust(width)}  {operand.help}")

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


def clap_group_refusal(
    name: str, spec: CommandSpec, subcommands: SubcommandRows, message: str
) -> bytes:
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
    return (
        f"{message}\n\n{usage}\n\nFor more information, try '--help'.\n"
    ).encode()


def argparse_help(
    name: str, spec: CommandSpec, subcommands: SubcommandRows = ()
) -> str:
    """Human-readable CLI help from the declared argparse-shaped grammar.

    Args:
        name (str): Installed command and canonical subcommand path.
        spec (CommandSpec): Argument grammar for this node; group
            options are listed on their group.
        subcommands (SubcommandRows): Visible immediate subcommands.
    """
    compiled = compile_spec(spec)
    usage = [name]
    rows = []
    for opt in compiled.options:
        value = opt.metavar or (
            "{" + ",".join(opt.choices) + "}"
            if opt.choices
            else option_metavar(opt)
        )
        suffix = "" if opt.action in ("store_true", "count") else " " + value
        if opt.value_types:
            suffix = " NAME " + value
        elif isinstance(opt.nargs, int):
            suffix = (" " + value) * opt.nargs
        if opt.nargs == "?":
            suffix = ("[=" if opt.attached_only else " [") + value + "]"
        flags = ", ".join(flag + suffix for flag in opt.names)
        slot = (option_spellings(opt)[0] or argument_dest(opt)) + suffix
        usage.append(slot if opt.required else "[" + slot + "]")
        details = [opt.help or ""]
        if opt.default is not None:
            details.append(f"(default: {opt.default})")
        if opt.env is not None:
            details.append(f"(env: {opt.env})")
        if opt.required:
            details.append("(required)")
        if opt.action in ("append", "extend"):
            details.append("(repeatable)")
        rows.append((flags, " ".join(v for v in details if v)))
    operands = []
    for operand in (
        *compiled.positional,
        *((compiled.rest,) if compiled.rest else ()),
    ):
        label = positional_name(operand) or (
            "PATH" if operand.type == "path" else "ARG"
        )
        slot = label + (" ..." if operand is compiled.rest else "")
        usage.append(
            slot if positional_required(operand) else "[" + slot + "]"
        )
        operands.append(
            (
                label,
                operand.help
                if operand.help is not None
                else ("Virtual path" if operand.type == "path" else ""),
            )
        )
    if subcommands:
        usage.append("{" + ",".join(sub for sub, _ in subcommands) + "} ...")
    lines = ["usage: " + " ".join(usage)]
    if spec.description:
        lines.extend(["", spec.description])
    for title, table in (
        ("positional arguments:", operands),
        ("commands:", subcommands),
        ("options:", rows),
    ):
        if not table:
            continue
        lines.extend(["", title])
        width = max(len(label) for label, _ in table)
        for label, description in table:
            lines.append(
                ("  " + label.ljust(width) + "  " + description).rstrip()
            )
    if spec.epilog:
        lines.extend(["", spec.epilog.rstrip("\n")])
    return "\n".join(lines) + "\n"
