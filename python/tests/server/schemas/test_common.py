from mirage.server.schemas.common import MountSummary, SessionSummary


def test_mount_summary_defaults_description_empty():
    summary = MountSummary(prefix="/data", vfs="ram", mode="rw")
    assert summary.description == ""
    assert summary.model_dump() == {
        "prefix": "/data",
        "vfs": "ram",
        "mode": "rw",
        "description": "",
    }


def test_session_summary_round_trips():
    summary = SessionSummary(session_id="s1", cwd="/data")
    assert SessionSummary.model_validate(summary.model_dump()) == summary
