from typing import TYPE_CHECKING

from mirage.utils.loader import lazy_exports
from mirage.vfs.chroma.config import ChromaConfig

if TYPE_CHECKING:
    from mirage.vfs.chroma.chroma import ChromaVFS

__all__ = ["ChromaConfig", "ChromaVFS"]

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.vfs.chroma.chroma": ("ChromaVFS",),
}

__getattr__ = lazy_exports(__name__, _EXPORTS)
