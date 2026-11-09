// Fills `{owner}`, `{repo}` and `{branch}` as gh 2.85.0's pkg/cmd/api does
// (MIT; see licenses/third_party/gh.txt).

use super::client::{Account, Result, value};
use super::repo::parse_repo;

const EXPAND_ERROR: &str = "unable to expand placeholder in path";
const NAMES: [&str; 3] = ["owner", "repo", "branch"];

fn expansion(name: &str, account: &Account) -> Result<String> {
    if name == "branch" {
        return match account.branch.as_deref() {
            Some(branch) if !branch.is_empty() => Ok(branch.to_owned()),
            _ => value(format!("{EXPAND_ERROR}: no `branch` on the install")),
        };
    }
    let Some(repo) = account.repo.as_deref().filter(|repo| !repo.is_empty()) else {
        return value(format!("{EXPAND_ERROR}: no `repo` on the install"));
    };
    let parsed = parse_repo(repo)?;
    Ok(if name == "owner" {
        parsed.owner
    } else {
        parsed.repo
    })
}

/// `{owner}`, `{repo}` and `{branch}` from the install, which stands in
/// for the repository of the current directory. Any other brace pair is
/// left as typed.
pub(crate) fn expand(text: &str, account: &Account) -> Result<String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find('{') {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 1..];
        let name = NAMES.iter().find(|name| {
            tail.strip_prefix(**name)
                .is_some_and(|after| after.starts_with('}'))
        });
        match name {
            Some(name) => {
                out.push_str(&expansion(name, account)?);
                rest = &tail[name.len() + 1..];
            }
            None => {
                out.push('{');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}
