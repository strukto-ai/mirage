from collections.abc import Mapping

from mirage.commands.builtin.generic.expand import tabs_config, tabs_generic
from mirage.commands.config import Context
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn


def unexpand_config(
    flags: Mapping[str, FlagValue],
) -> dict[str, JsonValue] | IOResult:
    """unexpand's engine config: ``tabs_config`` over ``-t``, ``-a`` and
    ``--first-only``.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.
    """
    return tabs_config("unexpand", ("tabs", "all", "first_only"), flags)


async def unexpand_generic(
    config: Mapping[str, JsonValue],
    paths: list[PathSpec],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run unexpand over resolved operands; mirrors unexpandGeneric.

    Args:
        config (Mapping[str, JsonValue]): ``unexpand_config``'s config.
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        ctx (Context): Stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    return await tabs_generic("unexpand", config, paths, ctx, stat, stream)


__all__ = ["unexpand_config", "unexpand_generic"]
