# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from collections.abc import Mapping

from opentelemetry import context, propagate, trace
from starlette.types import ASGIApp, Receive, Scope, Send


def request_context(headers: Mapping[str, str]) -> context.Context:
    """The context a request runs under, so the spans of the lines it
    starts join the caller's trace. A span already open for it, as an
    instrumentation library opens one under the caller's, is kept;
    otherwise the caller's span comes from ``headers`` through the
    process's propagator (W3C ``traceparent`` unless ``OTEL_PROPAGATORS``
    names another). A request that names none starts no trace.

    Args:
        headers (Mapping[str, str]): the request's headers, lowercase
            names.
    """
    current = context.get_current()
    if trace.get_current_span(current).get_span_context().is_valid:
        return current
    return propagate.extract(headers, context=current)


class TraceContextMiddleware:
    """Run each HTTP or websocket request under ``request_context``."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap ``app``.

        Args:
            app (ASGIApp): the application it runs requests on.
        """
        self.app = app

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {
            name.decode("latin-1"): value.decode("latin-1")
            for name, value in scope["headers"]
        }
        token = context.attach(request_context(headers))
        try:
            await self.app(scope, receive, send)
        finally:
            context.detach(token)
