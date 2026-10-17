from urllib.parse import urlsplit

from mirage.commands.cli.builtin.gh.accessor import web_origin
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.client import GitHubApiError
from mirage.core.github.config import GhConfig
from mirage.core.github.repo import login
from mirage.io.types import IOResult
from mirage.types import PathSpec


async def status(
    config: GhConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[bytes | None, IOResult]:
    """Check the configured credential without accessing a mount.

    The config stores a resolved secret, not its environment/file origin, so
    identify that source honestly and never print the credential itself.

    Args:
        config (GhConfig): the configured GitHub account.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the text operands.
        ctx (Context): the invocation's context.
    """
    host = urlsplit(web_origin(config)).hostname
    try:
        account = await login(config)
    except GitHubApiError as exc:
        if exc.status not in (401, 403):
            raise
        text = (
            f"{host}\n  X Failed to log in using the token in "
            f"Mirage configuration (HTTP {exc.status})\n"
        )
        return None, IOResult(exit_code=1, stderr=text.encode())
    if not account:
        return None, IOResult(
            exit_code=1,
            stderr=f"{host}: authenticated response has no login\n".encode(),
        )
    text = (
        f"{host}\n  ✓ Logged in to {host} account {account} "
        "(Mirage configuration)\n  - Active account: true\n"
    )
    return text.encode(), IOResult()


async def token(
    config: GhConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[bytes | None, IOResult]:
    """``gh auth token``, refused: the token stays in Mirage
    configuration, where every gh verb reads it, and is never printed.

    Args:
        config (GhConfig): the configured GitHub account.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the text operands.
        ctx (Context): the invocation's context; ``--hostname`` rides its flags.
    """
    host = (
        FlagView(ctx.flags).as_str("hostname")
        or urlsplit(web_origin(config)).hostname
    )
    text = (
        f"gh auth token: the token for {host} stays in Mirage "
        "configuration and is never printed; gh commands use it directly\n"
    )
    return None, IOResult(exit_code=1, stderr=text.encode())
