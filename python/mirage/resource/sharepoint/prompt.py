PROMPT = """\
{prefix}
  SharePoint Enterprise document libraries. Multi-site, multi-drive discovery.
  Path structure: /{site_name}/{library_name}/{path_to_file}
  Level 0 (ls /): lists all accessible SharePoint sites.
  Level 1 (ls /site/): lists document libraries (drives) in that site.
  Level 2+ (ls /site/lib/...): lists files and folders in the drive.
  IMPORTANT: This is a remote mount. Prefer targeted reads (grep, head) \
over full scans. Avoid cat on large files without piping to head/tail.
  Supports: ls, cat, head, tail, grep, rg, wc, find, tree, jq, stat.
  cat on .parquet/.orc/.feather returns a formatted table.
  File versions are retained, snapshots pin and read prior versions."""
