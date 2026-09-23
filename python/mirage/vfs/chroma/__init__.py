from mirage.vfs.chroma.config import ChromaConfig

__all__ = ["ChromaConfig", "ChromaVFS"]


def __getattr__(name: str):
    if name == "ChromaVFS":
        from mirage.vfs.chroma.chroma import ChromaVFS
        return ChromaVFS
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
