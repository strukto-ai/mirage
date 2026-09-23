PROMPT = """Read-only W&B experiments: /<entity>/<project>/<run-id>/ contains
run.json (identity, creator, sweep/group/job, tags, timestamps, notes, system metrics,
history keys/count and file count), config.json, summary.json, history.jsonl and files/.
Run IDs are stable; display names may repeat. history.jsonl scans unsampled history
in original order, preserving missing metrics and _step. Logged training-step keys
are independent of _step. Summary metrics are stored values, not history maxima.
Listings and reads are lazy. History reads may be large; use head to stream a prefix.
Only configured entities are visible. Files retain their run-relative paths.
files/wandb-metadata.json, when present, describes the machine/runtime environment.
run.json user contains the creator's id, name, username and email, when available.
Missing run metadata is null. run.json read_only is W&B's permission, not mount mode.
"""
