from mirage.resource.dify.config import DifyConfig

__all__ = ["DifyConfig", "DifyResource"]


def __getattr__(name: str):
    if name == "DifyResource":
        from mirage.resource.dify.dify import DifyResource
        return DifyResource
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
