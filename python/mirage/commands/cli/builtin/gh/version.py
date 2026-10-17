from mirage.commands.config import Context
from mirage.core.github.config import GhConfig
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.version import __version__


async def version(
    config: GhConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[bytes, IOResult]:
    """Report Mirage's package version instead of an upstream gh build and URL.

    Args:
        config (GhConfig): the install's account config.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the text operands.
        ctx (Context): the invocation's context.
    """
    return f"gh version {__version__} (Mirage)\n".encode(), IOResult()
