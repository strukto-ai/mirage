from mirage.vfs.dify.config import DifyConfig

__all__ = ["DifyConfig", "DifyVFS"]


def __getattr__(name: str):
    if name == "DifyVFS":
        from mirage.vfs.dify.dify import DifyVFS
        return DifyVFS
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
