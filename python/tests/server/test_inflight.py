from mirage.server.inflight import InFlight, rpc_messages


def test_cancel_reaches_a_held_call_once():
    inflight = InFlight()
    cancelled: list[str] = []

    def stop() -> bool:
        cancelled.append("stopped")
        return True

    key = InFlight.key("ws", "s", 7)
    inflight.add(key, stop)
    assert inflight.cancel(InFlight.key("ws", "other", 7)) is False
    assert inflight.cancel(key) is True
    assert inflight.cancel(key) is False
    assert cancelled == ["stopped"]


def test_a_discarded_call_is_not_cancelled():
    inflight = InFlight()
    key = InFlight.key("ws", "s", "a")

    def cancel() -> bool:
        return True

    inflight.add(key, cancel)
    inflight.discard(key, cancel)
    assert inflight.cancel(key) is False


def test_two_calls_that_share_an_id_stay_apart():
    inflight = InFlight()
    stopped: list[str] = []
    key = InFlight.key("ws", "s", 1)
    calls = {
        name: (lambda name=name: stopped.append(name) is None)
        for name in ("first", "second", "third")
    }
    for cancel in calls.values():
        inflight.add(key, cancel)
    inflight.discard(key, calls["first"])
    assert inflight.cancel(key) is True
    assert stopped == ["second", "third"]


def test_rpc_messages_reads_one_or_a_batch():
    assert rpc_messages(b'{"id": 1}') == [{"id": 1}]
    assert rpc_messages(b'[{"id": 1}, 3, {"id": 2}]') == [{"id": 1}, {"id": 2}]
    assert rpc_messages(b"not json") == []
