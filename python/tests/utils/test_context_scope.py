import asyncio
from contextvars import ContextVar

from mirage.utils.context_scope import ContextScope


def test_deferred_stream_retains_producer_context_and_closes_there():
    current = ContextVar("stream_test", default="caller")
    closed = []

    async def run():
        token = current.set("producer")
        scope = ContextScope()
        current.reset(token)

        consumer = asyncio.current_task()

        async def source():
            assert current.get() == "producer"
            assert asyncio.current_task() is consumer
            inner = current.set("inner")
            try:
                yield current.get()
                yield current.get()
            finally:
                closed.append(current.get())
                current.reset(inner)

        stream = scope.stream(source())
        assert await anext(stream) == "inner"
        assert current.get() == "caller"
        assert await anext(stream) == "inner"
        await stream.aclose()
        assert current.get() == "caller"

    asyncio.run(run())
    assert closed == ["inner"]
