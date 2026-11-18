#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod commands;
mod fs_util;
mod file_ops;
mod git;
mod lsp;
mod pty;
mod search;
mod state;
mod tasks;
mod watcher;

use tauri::Manager;

use crate::state::AppState;
use crate::watcher::{should_watch, WorkspaceWatcher};

fn main() {
    let workspace = state::default_workspace();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new(workspace.clone()))
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            if should_watch(&workspace) {
                match WorkspaceWatcher::start(&handle, &workspace) {
                    Ok(watcher) => {
                        if let Ok(mut guard) = state.watcher.lock() {
                            *guard = Some(watcher);
                        }
                    }
                    Err(error) => eprintln!("watcher non avviato: {error}"),
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_workspace,
            commands::pick_folder,
            commands::open_workspace,
            commands::create_workspace,
            commands::open_new_window,
            commands::startup_empty_requested,
            commands::list_directory,
            commands::create_entry,
            file_ops::mutate_entries,
            commands::read_file_text,
            commands::save_file,
            commands::pty_create,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_snapshot,
            commands::pty_close,
            commands::accept_diff,
            commands::reject_diff,
            commands::run_agent_prompt,
            commands::get_agent_config,
            commands::search_text,
            commands::replace_text,
            commands::search_files,
            commands::git_status,
            git::git_branches,
            git::git_checkout,
            git::git_create_branch,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_cherry_pick,
            git::git_merge,
            git::git_complete_merge,
            git::git_abort_merge,
            git::git_resolve_conflict,
            git::git_take_side,
            git::git_fetch,
            git::git_file_diff,
            git::git_revert_file,
            git::git_revert_all,
            git::git_commit_files,
            git::git_commit_file_diff,
            git::git_log,
            commands::workspace_tasks,
            tasks::task_run,
            tasks::task_stop,
            commands::lsp_open_file,
            commands::lsp_sync_file,
            commands::lsp_completion,
            commands::lsp_navigate,
            commands::lsp_close_file,
            commands::lsp_save_file,
            commands::lsp_read_target,
        ])
        .run(tauri::generate_context!())
        .expect("errore nell'avvio di helmcode");
    tasks::stop_all();
}
