from urllib.parse import urlsplit

from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.client import GitHubApiError
from mirage.core.github.config import GhConfig
from mirage.core.github.repo import login
from mirage.io.types import IOResult


async def status(
    inv: CLIInvocation[GhConfig],
) -> tuple[bytes | None, IOResult]:
    """Check the configured credential without accessing a mount.

    The config stores a resolved secret, not its environment/file origin, so
    identify that source honestly and never print the credential itself.

    Args:
        inv (CLIInvocation[GhConfig]): configured GitHub invocation.
    """
    host = urlsplit(inv.config.base_url or "https://github.com").hostname
    if host == "api.github.com":
        host = "github.com"
    try:
        account = await login(inv.config)
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
    inv: CLIInvocation[GhConfig],
) -> tuple[bytes | None, IOResult]:
    """``gh auth token``, refused: the token stays in Mirage
    configuration, where every gh verb reads it, and is never printed.

    Args:
        inv (CLIInvocation[GhConfig]): configured GitHub invocation.
    """
    host = (
        FlagView(inv.flags).as_str("hostname")
        or urlsplit(inv.config.base_url or "https://github.com").hostname
    )
    if host == "api.github.com":
        host = "github.com"
    text = (
        f"gh auth token: the token for {host} stays in Mirage "
        "configuration and is never printed; gh commands use it directly\n"
    )
    return None, IOResult(exit_code=1, stderr=text.encode())
