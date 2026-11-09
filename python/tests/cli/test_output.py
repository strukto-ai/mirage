import pytest

from mirage.cli.output import emit, exit_code_from_response


@pytest.mark.parametrize(
    "response,expected",
    [
        pytest.param(
            {"exit_code": 0, "stdout": "", "stderr": ""},
            0,
            id="test_io_zero",
        ),
        pytest.param(
            {"exit_code": 1, "stdout": "", "stderr": ""},
            1,
            id="test_io_nonzero_1",
        ),
        pytest.param(
            {"exit_code": 42, "stdout": "", "stderr": ""},
            42,
            id="test_io_nonzero_2",
        ),
        pytest.param(
            {"exit_code": 127, "stdout": "", "stderr": ""},
            127,
            id="test_io_nonzero_3",
        ),
        pytest.param({"exit_code": 300}, 255, id="test_clamp_high"),
        pytest.param({"exit_code": -1}, 0, id="test_clamp_negative"),
        pytest.param({"exit_code": 1.9}, 1, id="test_truncate_float"),
        pytest.param(
            {"exit_code": float("nan")},
            0,
            id="test_nan_returns_zero",
        ),
        pytest.param(
            {"exit_code": float("inf")},
            0,
            id="test_inf_returns_zero",
        ),
        pytest.param({"exit_code": True}, 0, id="test_bool_returns_zero"),
        pytest.param(
            {"job_id": "job_abc", "workspace_id": "ws", "submitted_at": 0},
            0,
            id="test_bg_submission",
        ),
        pytest.param({"value": "hi"}, 0, id="test_no_exit_code_field"),
        pytest.param(
            {
                "job_id": "job_x",
                "status": "done",
                "result": {
                    "exit_code": 7,
                    "stdout": "",
                    "stderr": "",
                },
                "error": None,
            },
            7,
            id="test_job_detail_done",
        ),
        pytest.param(
            {
                "job_id": "job_x",
                "status": "pending",
                "result": None,
                "error": None,
            },
            0,
            id="test_job_pending_returns_zero",
        ),
        pytest.param(
            {
                "job_id": "job_x",
                "status": "running",
                "result": None,
                "error": None,
            },
            0,
            id="test_job_running_returns_zero",
        ),
        pytest.param(
            {
                "job_id": "job_x",
                "status": "failed",
                "result": None,
                "error": "boom",
            },
            2,
            id="test_job_failed_no_result_returns_two",
        ),
        pytest.param(
            {
                "job_id": "job_x",
                "status": "canceled",
                "result": None,
                "error": None,
            },
            2,
            id="test_job_canceled_no_result_returns_two",
        ),
        pytest.param(
            {
                "job_id": "job_x",
                "status": "failed",
                "result": {
                    "exit_code": 9,
                    "stdout": "",
                    "stderr": "",
                },
                "error": None,
            },
            9,
            id="test_job_failed_with_result_prefers_inner",
        ),
        pytest.param(None, 0, id="test_non_dict_inputs_1"),
        pytest.param("string", 0, id="test_non_dict_inputs_2"),
        pytest.param(42, 0, id="test_non_dict_inputs_3"),
        pytest.param([1, 2, 3], 0, id="test_non_dict_inputs_4"),
        pytest.param(
            {"stdout": "", "stderr": ""},
            0,
            id="test_io_missing_exit_code",
        ),
        pytest.param(
            {"exit_code": "one"},
            0,
            id="test_io_non_numeric_exit_code",
        ),
    ],
)
def test_exit_code_from_response(response, expected):
    assert exit_code_from_response(response) == expected


def test_emit_writes_non_ascii_as_raw_utf8(capsys):
    # `JSON.stringify` emits raw UTF-8, so `ensure_ascii` made the two
    # hosts print different bytes for the same value.
    #
    # This call is still not at parity: it also passes `default=str`,
    # which stringifies a value JSON cannot carry where `JSON.stringify`
    # throws. That divergence is orthogonal and left alone here.
    emit({"name": "Café", "city": "東京"})
    printed = capsys.readouterr().out
    assert '"Café"' in printed
    assert '"東京"' in printed
    assert "\\u" not in printed
