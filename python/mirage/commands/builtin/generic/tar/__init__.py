from typing import TYPE_CHECKING

from mirage.utils.loader import lazy_exports

if TYPE_CHECKING:
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
        CreateResult,
        Member,
    )

_EXPORTS: dict[str, tuple[str, ...]] = {
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
        "CreateResult",
        "Member",
    ),
}

__all__ = [
    "CreateResult",
    "Member",
    "TarFlags",
    "excluded",
    "member_name",
    "parse_flags",
    "plan_create",
    "pruned",
    "strip_prefix",
    "tar_generic",
]

__getattr__ = lazy_exports(__name__, _EXPORTS)
