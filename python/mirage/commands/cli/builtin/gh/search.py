from functools import partial

from mirage.commands.cli.builtin.gh.constants import (
    SEARCH_BOOLEAN,
    SEARCH_FLAGS,
    SEARCH_KIND_USAGE,
    SEARCH_MULTIPLE,
    SEARCH_QUERY_USE,
    SEARCH_SORTS,
    SEARCH_USAGE,
)
from mirage.commands.cli.builtin.gh.host import run_leaf
from mirage.commands.cli.types import CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec


def _usage(kind: str, name: str) -> tuple[str, str | None]:
    """A search flag's description and value name, as gh words them.

    Args:
        kind (str): the search leaf.
        name (str): the flag's long name.
    """
    return SEARCH_KIND_USAGE.get(kind, {}).get(name) or SEARCH_USAGE[name]


def _option(kind: str, name: str) -> Argument:
    choices = {
        "state": ("open", "closed"),
        "include-forks": ("false", "true", "only"),
        "checks": ("pending", "success", "failure"),
        "review": ("none", "required", "approved", "changes_requested"),
    }.get(name, ())
    short = {"repo": "-R", "base": "-B", "head": "-H"}.get(name)
    names = (short, "--" + name) if short is not None else ("--" + name,)
    description, metavar = _usage(kind, name)
    return Argument(
        *names,
        action="append" if name in SEARCH_MULTIPLE else "store",
        nargs="?" if name in SEARCH_BOOLEAN else None,
        attached_only=name in SEARCH_BOOLEAN,
        choices=("true", "false") if name in SEARCH_BOOLEAN else choices,
        metavar=metavar,
        help=description,
    )


def search_spec() -> CommandSpec:
    leaves = []
    for kind in SEARCH_FLAGS:
        options = [_option(kind, name) for name in SEARCH_FLAGS[kind]]
        options.extend(
            (
                Argument(
                    "--json",
                    metavar=_usage(kind, "json")[1],
                    help=_usage(kind, "json")[0],
                ),
                Argument(
                    "-q",
                    "--jq",
                    metavar=_usage(kind, "jq")[1],
                    help=_usage(kind, "jq")[0],
                ),
                Argument("-t", "--template", help=_usage(kind, "template")[0]),
                Argument(
                    "-L",
                    "--limit",
                    type="int",
                    default="30",
                    help=_usage(kind, "limit")[0],
                ),
            )
        )
        if kind in SEARCH_SORTS:
            options.extend(
                (
                    Argument(
                        "--sort",
                        choices=tuple(SEARCH_SORTS[kind]),
                        help=_usage(kind, "sort")[0],
                    ),
                    Argument(
                        "--order",
                        choices=("asc", "desc"),
                        help=_usage(kind, "order")[0],
                    ),
                )
            )
        leaves.append(
            CommandSpec(
                name=kind,
                description=f"Search for {kind}",
                arguments=(
                    *options,
                    Argument(
                        "QUERY",
                        nargs="*",
                        metavar=SEARCH_QUERY_USE.get(kind, "[<query>]"),
                    ),
                ),
            )
        )
    return CommandSpec(
        name="search", description="Search GitHub", subcommands=tuple(leaves)
    )


def search_handlers() -> dict[str, CLIHandler]:
    """Bind the search leaves by their canonical paths below gh."""
    return {
        f"search {kind}": CLIHandler(fn=partial(run_leaf, f"search {kind}"))
        for kind in SEARCH_FLAGS
    }
