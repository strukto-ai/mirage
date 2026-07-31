from typing import Any


def render_page(chunks: list[dict[str, Any]]) -> bytes:
    """Render a page's chunks as the file body.

    Args:
        chunks (list[dict]): the page's chunks, in chunk-index order.
    """
    # Single renderer for a page: read() and the size the directory scan
    # records must produce the same bytes for the same chunks, so the
    # advertised size is exact by construction.
    return "\n".join(chunk["document"] for chunk in chunks).encode()
