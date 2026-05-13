from mirage.cli.output import exit_code_from_response


def test_io_zero():
    assert exit_code_from_response({
        "kind": "io",
        "exit_code": 0,
        "stdout": "",
        "stderr": ""
    }) == 0


def test_io_nonzero():
    assert exit_code_from_response({
        "kind": "io",
        "exit_code": 1,
        "stdout": "",
        "stderr": ""
    }) == 1
    assert exit_code_from_response({
        "kind": "io",
        "exit_code": 42,
        "stdout": "",
        "stderr": ""
    }) == 42
    assert exit_code_from_response({
        "kind": "io",
        "exit_code": 127,
        "stdout": "",
        "stderr": ""
    }) == 127


def test_clamp_high():
    assert exit_code_from_response({"kind": "io", "exit_code": 300}) == 255


def test_clamp_negative():
    assert exit_code_from_response({"kind": "io", "exit_code": -1}) == 0


def test_truncate_float():
    assert exit_code_from_response({"kind": "io", "exit_code": 1.9}) == 1


def test_nan_returns_zero():
    assert exit_code_from_response({
        "kind": "io",
        "exit_code": float("nan")
    }) == 0


def test_inf_returns_zero():
    assert exit_code_from_response({
        "kind": "io",
        "exit_code": float("inf")
    }) == 0


def test_bool_returns_zero():
    assert exit_code_from_response({"kind": "io", "exit_code": True}) == 0


def test_bg_submission():
    assert exit_code_from_response({
        "job_id": "job_abc",
        "workspace_id": "ws",
        "submitted_at": 0,
    }) == 0


def test_provision_kind():
    assert exit_code_from_response({"kind": "provision", "detail": "ok"}) == 0


def test_raw_kind():
    assert exit_code_from_response({"kind": "raw", "value": "hi"}) == 0


def test_job_detail_done():
    assert exit_code_from_response({
        "job_id": "job_x",
        "status": "done",
        "result": {
            "kind": "io",
            "exit_code": 7,
            "stdout": "",
            "stderr": ""
        },
        "error": None,
    }) == 7


def test_job_pending_returns_zero():
    assert exit_code_from_response({
        "job_id": "job_x",
        "status": "pending",
        "result": None,
        "error": None,
    }) == 0


def test_job_running_returns_zero():
    assert exit_code_from_response({
        "job_id": "job_x",
        "status": "running",
        "result": None,
        "error": None,
    }) == 0


def test_job_failed_no_result_returns_two():
    assert exit_code_from_response({
        "job_id": "job_x",
        "status": "failed",
        "result": None,
        "error": "boom",
    }) == 2


def test_job_canceled_no_result_returns_two():
    assert exit_code_from_response({
        "job_id": "job_x",
        "status": "canceled",
        "result": None,
        "error": None,
    }) == 2


def test_job_failed_with_result_prefers_inner():
    assert exit_code_from_response({
        "job_id": "job_x",
        "status": "failed",
        "result": {
            "kind": "io",
            "exit_code": 9,
            "stdout": "",
            "stderr": ""
        },
        "error": None,
    }) == 9


def test_non_dict_inputs():
    assert exit_code_from_response(None) == 0
    assert exit_code_from_response("string") == 0
    assert exit_code_from_response(42) == 0
    assert exit_code_from_response([1, 2, 3]) == 0


def test_io_missing_exit_code():
    assert exit_code_from_response({
        "kind": "io",
        "stdout": "",
        "stderr": ""
    }) == 0


def test_io_non_numeric_exit_code():
    assert exit_code_from_response({"kind": "io", "exit_code": "one"}) == 0
