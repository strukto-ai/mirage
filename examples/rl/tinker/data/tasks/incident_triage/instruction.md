Inspect `/logs/events.jsonl` and the `#ops` channel mounted under `/slack/channels/ops__C1`.

1. Count how many `ERROR` entries appear in `/logs/events.jsonl`, identify the service with the highest `latency_ms`, and look up its owning team in `#ops`.
1. Write valid JSON to `/workspace/report.json` with keys `error_count` (int), `slowest_service` (string), `max_latency_ms` (int), and `owner` (string).
1. Post that JSON string to `#incidents` (`C2`) using `slack send-message --channel C2 --text ...`.
