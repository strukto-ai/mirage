// Follows gh 2.85.0's pkg/cmd/auth (MIT; see licenses/third_party/gh.txt).

use super::accessor::{Flags, Out, web_host};
use crate::core::github::client::{Account, Result, github_request_response};
use crate::core::github::repo::current_login;

const TOKEN_SOURCE: &str = "Mirage configuration";

fn listed_scopes(scopes: &str) -> String {
    if scopes.is_empty() {
        return "none".to_owned();
    }
    scopes
        .split(',')
        .map(|scope| format!("'{}'", scope.trim()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The scopes gh needs that the token lacks; a token that reports none
/// is taken for an integration's and not judged.
fn missing_scopes(scopes: &str) -> Vec<&'static str> {
    if scopes.is_empty() {
        return Vec::new();
    }
    let held: Vec<&str> = scopes.split(',').map(str::trim).collect();
    let mut missing = Vec::new();
    if !held.contains(&"repo") {
        missing.push("repo");
    }
    if !["read:org", "write:org", "admin:org"]
        .iter()
        .any(|scope| held.contains(scope))
    {
        missing.push("read:org");
    }
    missing
}

/// Check the configured credential; the credential itself is never
/// printed, only the mask the host made of it.
pub(crate) async fn status(account: &Account) -> Result<Out> {
    let host = web_host(account)?;
    let failed = |who: String| {
        Ok(Out::failed(format!(
            "{host}\n  X Failed to log in to {host} {who} ({TOKEN_SOURCE})\n  - Active account: true\n  - The token in {TOKEN_SOURCE} is invalid.\n"
        )))
    };
    let Ok(name) = current_login(account).await else {
        return failed("using token".to_owned());
    };
    let Ok(root) = github_request_response(account, "GET", "/", None, &[], &[]).await else {
        return failed(format!("account {name}"));
    };
    let scopes = root
        .headers
        .get("x-oauth-scopes")
        .cloned()
        .unwrap_or_default();
    let mask = &account.token_mask;
    let mut text = format!(
        "{host}\n  \u{2713} Logged in to {host} account {name} ({TOKEN_SOURCE})\n  - Active account: true\n  - Git operations protocol: https\n  - Token: {mask}\n"
    );
    if mask.starts_with("ghp_") || mask.starts_with("gho_") {
        text.push_str(&format!("  - Token scopes: {}\n", listed_scopes(&scopes)));
        let missing = missing_scopes(&scopes);
        if !missing.is_empty() {
            text.push_str(&format!(
                "  ! Missing required token scopes: {}\n  - To request missing scopes, run: gh auth refresh -h {host}\n",
                listed_scopes(&missing.join(","))
            ));
        }
    }
    Ok(Out::text(text))
}

/// `gh auth token`, refused: the token stays in Mirage configuration.
pub(crate) fn token(account: &Account, flags: &Flags) -> Result<Out> {
    let host = match flags.as_nonempty("hostname") {
        Some(host) => host.to_owned(),
        None => web_host(account)?,
    };
    Ok(Out::failed(format!(
        "gh auth token: the token for {host} stays in Mirage configuration and is never printed; gh commands use it directly\n"
    )))
}

#[cfg(test)]
mod tests {
    use super::{listed_scopes, missing_scopes};

    #[test]
    fn scopes_list_as_gh_quotes_them() {
        assert_eq!(listed_scopes(""), "none");
        assert_eq!(listed_scopes("repo, read:org"), "'repo', 'read:org'");
    }

    #[test]
    fn only_a_token_reporting_scopes_is_judged() {
        assert!(missing_scopes("").is_empty());
        assert!(missing_scopes("repo, admin:org").is_empty());
        assert_eq!(missing_scopes("gist"), ["repo", "read:org"]);
        assert_eq!(missing_scopes("write:org"), ["repo"]);
    }
}
