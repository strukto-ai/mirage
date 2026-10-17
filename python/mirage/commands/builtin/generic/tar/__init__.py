import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mirage.commands.builtin.generic.tar.constants import READ_MODES
    from mirage.commands.builtin.generic.tar.create import (
        excluded,
        member_name,
        plan_create,
        pruned,
        strip_prefix,
    )
    from mirage.commands.builtin.generic.tar.tar import (
        TarFlags,
        parse_flags,
        tar_generic,
    )
    from mirage.commands.builtin.generic.tar.types import (
        CompressionSuffix,
        CreateResult,
        Member,
        ReadMode,
    )

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.commands.builtin.generic.tar.constants": ("READ_MODES",),
    "mirage.commands.builtin.generic.tar.create": (
        "excluded",
        "member_name",
        "plan_create",
        "pruned",
        "strip_prefix",
    ),
    "mirage.commands.builtin.generic.tar.tar": (
        "TarFlags",
        "parse_flags",
        "tar_generic",
    ),
    "mirage.commands.builtin.generic.tar.types": (
        "CompressionSuffix",
        "CreateResult",
        "Member",
        "ReadMode",
    ),
}
_MODULE_OF = {
    name: module for module, names in _EXPORTS.items() for name in names
}

__all__ = [
    "CompressionSuffix",
    "CreateResult",
    "Member",
    "READ_MODES",
    "ReadMode",
    "TarFlags",
    "excluded",
    "member_name",
    "parse_flags",
    "plan_create",
    "pruned",
    "strip_prefix",
    "tar_generic",
]


def __getattr__(name: str) -> Any:
    module = _MODULE_OF.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module), name)
    globals()[name] = value
    return value
