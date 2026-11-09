//! The GitHub CLI: every subcommand's body, over host requests. The host
//! parses the line and applies policy before this runs, and sends every
//! call and reads every file for it.

mod accessor;
mod actions;
mod api;
mod args;
mod auth;
mod cache;
mod constants;
mod editable;
mod fields;
mod gist;
mod issue;
mod label;
mod org;
mod pull;
mod release;
mod repo;
mod repo_admin;
mod ruleset;
mod search;
mod secret;
mod shape;
mod template;
mod variable;
mod version;

use args::check_args;
use serde::Deserialize;

use self::accessor::{Flags, Out};
use crate::core::github::client::{Account, Failure, Result};
use crate::core::github::json::{Json, Obj};
use crate::request::Request;
use crate::task::{Host, spawn};
use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
struct Config {
    leaf: String,
    flags: Json,
    texts: Vec<String>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    token_mask: String,
    #[serde(default)]
    base_url: Option<String>,
    version: String,
    argv_len: usize,
    #[serde(default)]
    argv: Vec<String>,
    #[serde(default)]
    value_flag: bool,
}

async fn dispatch(leaf: &str, account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    match leaf {
        "auth status" => auth::status(account).await,
        "auth token" => auth::token(account, flags),
        "version" => Ok(version::version(account)),
        "api" => api::api(account, flags, texts).await,
        "repo archive" => repo_admin::archive_cmd(account, flags, texts).await,
        "repo unarchive" => repo_admin::unarchive_cmd(account, flags, texts).await,
        "repo sync" => repo_admin::sync_cmd(account, flags, texts).await,
        "repo deploy-key list" => repo_admin::deploy_key_list_cmd(account, flags).await,
        "repo deploy-key add" => repo_admin::deploy_key_add_cmd(account, flags, texts).await,
        "repo deploy-key delete" => repo_admin::deploy_key_delete_cmd(account, flags, texts).await,
        "repo autolink list" => repo_admin::autolink_list_cmd(account, flags).await,
        "repo autolink create" => repo_admin::autolink_create_cmd(account, flags, texts).await,
        "repo autolink view" => repo_admin::autolink_view_cmd(account, flags, texts).await,
        "repo autolink delete" => repo_admin::autolink_delete_cmd(account, flags, texts).await,
        "repo gitignore list" => repo_admin::gitignore_list_cmd(account).await,
        "repo gitignore view" => repo_admin::gitignore_view_cmd(account, texts).await,
        "repo license list" => repo_admin::license_list_cmd(account).await,
        "repo license view" => repo_admin::license_view_cmd(account, texts).await,
        "run cancel" => actions::run_cancel_cmd(account, flags, texts).await,
        "run delete" => actions::run_delete_cmd(account, flags, texts).await,
        "workflow enable" => actions::workflow_toggle(account, flags, texts, true).await,
        "workflow disable" => actions::workflow_toggle(account, flags, texts, false).await,
        "release edit" => release::edit_cmd(account, flags, texts).await,
        "release delete" => release::delete_cmd(account, flags, texts).await,
        "release delete-asset" => release::delete_asset_cmd(account, flags, texts).await,
        "gist list" => gist::list_cmd(account, flags).await,
        "gist view" => gist::view_cmd(account, flags, texts).await,
        "gist create" => gist::create_cmd(account, flags, texts).await,
        "gist edit" => gist::edit_cmd(account, flags, texts).await,
        "gist delete" => gist::delete_cmd(account, flags, texts).await,
        "gist rename" => gist::rename_cmd(account, flags, texts).await,
        "org list" => org::list_cmd(account, flags).await,
        "ruleset list" => ruleset::list_cmd(account, flags).await,
        "ruleset view" => ruleset::view_cmd(account, flags, texts).await,
        "ruleset check" => ruleset::check_cmd(account, flags, texts).await,
        "label list" => label::list_cmd(account, flags).await,
        "label create" => label::create_cmd(account, flags, texts).await,
        "label edit" => label::edit_cmd(account, flags, texts).await,
        "label delete" => label::delete_cmd(account, flags, texts).await,
        "label clone" => label::clone_cmd(account, flags, texts).await,
        "cache list" => cache::list_cmd(account, flags).await,
        "cache delete" => cache::delete_cmd(account, flags, texts).await,
        "variable list" => variable::list_cmd(account, flags).await,
        "variable get" => variable::get_cmd(account, flags, texts).await,
        "variable set" => variable::set_cmd(account, flags, texts).await,
        "variable delete" => variable::delete_cmd(account, flags, texts).await,
        "secret list" => secret::list_cmd(account, flags).await,
        "secret delete" => secret::delete_cmd(account, flags, texts).await,
        "issue list" => issue::list_cmd(account, flags).await,
        "issue view" => issue::view_cmd(account, flags, texts).await,
        "issue create" => issue::create_cmd(account, flags).await,
        "issue edit" => issue::edit_cmd(account, flags, texts).await,
        "issue close" => issue::close_cmd(account, flags, texts).await,
        "issue reopen" => issue::reopen_cmd(account, flags, texts).await,
        "issue pin" => issue::pin_cmd(account, flags, texts).await,
        "issue unpin" => issue::unpin_cmd(account, flags, texts).await,
        "issue delete" => issue::delete_cmd(account, flags, texts).await,
        "issue transfer" => issue::transfer_cmd(account, flags, texts).await,
        "issue lock" => issue::lock_run(account, flags, texts, false, true).await,
        "issue unlock" => issue::lock_run(account, flags, texts, false, false).await,
        "issue status" => issue::status_cmd(account, flags, texts).await,
        "pr lock" => issue::lock_run(account, flags, texts, true, true).await,
        "pr unlock" => issue::lock_run(account, flags, texts, true, false).await,
        "pr review" => pull::review_cmd(account, flags, texts).await,
        "pr ready" => pull::ready_cmd(account, flags, texts).await,
        "pr update-branch" => pull::update_branch_cmd(account, flags, texts).await,
        "pr revert" => pull::revert_cmd(account, flags, texts).await,
        "pr status" => pull::status_cmd(account, flags).await,
        "issue comment" => issue::comment_cmd(account, flags, texts).await,
        "pr list" => pull::list_cmd(account, flags).await,
        "pr view" => pull::view_cmd(account, flags, texts).await,
        "pr create" => pull::create_cmd(account, flags).await,
        "pr edit" => pull::edit_cmd(account, flags, texts).await,
        "pr merge" => pull::merge_cmd(account, flags, texts).await,
        "pr close" => pull::close_cmd(account, flags, texts).await,
        "pr reopen" => pull::reopen_cmd(account, flags, texts).await,
        "pr comment" => pull::comment_cmd(account, flags, texts).await,
        "pr diff" => pull::diff_cmd(account, flags, texts).await,
        "pr checks" => pull::checks_cmd(account, flags, texts).await,
        "repo list" => repo::list_cmd(account, flags, texts).await,
        "repo view" => repo::view(account, flags, texts).await,
        "repo create" => repo::create_cmd(account, flags, texts).await,
        "repo fork" => repo::fork(account, flags, texts).await,
        "repo rename" => repo::rename(account, flags, texts).await,
        "repo edit" => repo::edit_cmd(account, flags, texts).await,
        "repo delete" => repo::delete_cmd(account, flags, texts).await,
        "release list" => release::list_cmd(account, flags).await,
        "release view" => release::view_cmd(account, flags, texts).await,
        "release create" => release::create_cmd(account, flags, texts).await,
        "run list" => actions::run_list_cmd(account, flags).await,
        "run view" => actions::run_view_cmd(account, flags, texts).await,
        "run rerun" => actions::run_rerun_cmd(account, flags, texts).await,
        "workflow list" => actions::workflow_list_cmd(account, flags).await,
        "workflow view" => actions::workflow_view_cmd(account, flags, texts).await,
        "workflow run" => actions::workflow_run_cmd(account, flags, texts).await,
        other => match other.strip_prefix("search ") {
            Some(kind) => search::search_cmd(kind, account, flags, texts).await,
            None => Err(Failure::Value(format!("gh: unknown command {other}"))),
        },
    }
}

async fn run(config: Config, host: Host) -> i32 {
    let account = Account {
        host: host.clone(),
        repo: config.repo,
        branch: config.branch,
        token_mask: config.token_mask,
        base_url: config.base_url,
        version: config.version,
        argv_len: config.argv_len,
        argv: config.argv,
    };
    let flags = Flags(match config.flags {
        Json::Obj(flags) => flags,
        _ => Obj::new(),
    });
    let outcome = match check_args(&config.leaf, &config.texts, config.value_flag) {
        Ok(()) => dispatch(&config.leaf, &account, &flags, &config.texts).await,
        Err(failure) => Err(failure),
    };
    match outcome {
        Ok(out) => {
            host.print(&out.stdout);
            host.warn(&out.stderr);
            out.exit
        }
        Err(failure) => {
            let (kind, code) = match &failure {
                Failure::Usage(_, code) => ("usage", *code),
                _ => ("value", 1),
            };
            let message = failure.text();
            if let Failure::Printed { output, .. } = &failure {
                host.print(output);
            }
            host.ask(Request::Fail {
                kind,
                message,
                code,
            })
            .await;
            1
        }
    }
}

/// The stream that runs one subcommand.
pub fn open(config: &[u8]) -> std::result::Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(spawn(move |host| run(config, host)))
}
