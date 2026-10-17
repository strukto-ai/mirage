from mirage.accessor.github import GitHubAccount
from mirage.commands.config import Context
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.version import __version__


async def version(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[bytes, IOResult]:
    """Report Mirage's package version instead of an upstream gh build and URL.

    Args:
        accessor (GitHubAccount): the install's account.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the text operands.
        ctx (Context): the invocation's context.
    """
    return f"gh version {__version__} (Mirage)\n".encode(), IOResult()
