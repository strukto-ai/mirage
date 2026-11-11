from mirage.cli.daemon import _format_status


def test_status_reads_uptime_in_milliseconds():
    said = _format_status(
        {
            "running": True,
            "pid": 7,
            "url": "http://127.0.0.1:8765",
            "uptime_ms": 90_000,
            "workspaces": 1,
        }
    )
    assert said == (
        "Running. PID 7, uptime 1m, 1 workspace. URL: http://127.0.0.1:8765"
    )
