from typing import TYPE_CHECKING

from mirage.utils.loader import lazy_exports
from mirage.vfs.dify.config import DifyConfig

if TYPE_CHECKING:
    from mirage.vfs.dify.dify import DifyVFS

__all__ = ["DifyConfig", "DifyVFS"]

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.vfs.dify.dify": ("DifyVFS",),
}

__getattr__ = lazy_exports(__name__, _EXPORTS)
