mod commands;
mod lifecycle;
mod ray_api;
mod state;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(lifecycle::LifecycleManager::default())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open RayLab", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "Start / Stop Ray", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit RayLab", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &toggle, &quit])?;
            let mut tray = TrayIconBuilder::with_id("raylab-tray")
                .tooltip("RayLab")
                .menu(&menu)
                .show_menu_on_left_click(true);
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "toggle" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tray_toggle(app).await;
                });
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_app_state,
            commands::save_app_state,
            commands::ray_api_version,
            commands::list_jobs,
            commands::get_job,
            commands::get_job_logs,
            commands::submit_job,
            commands::stop_job,
            commands::delete_job,
            commands::list_nodes,
            commands::detect_local_node_ip,
            commands::check_worker_connection,
            commands::ray_runtime_status,
            commands::install_ray_runtime,
            commands::lifecycle_status,
            commands::start_lifecycle,
            commands::stop_lifecycle,
            commands::ensure_cluster_token,
            commands::save_cluster_token,
            commands::reveal_cluster_token,
            commands::rotate_cluster_token,
            commands::check_local_ports,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RayLab");
}

async fn tray_toggle(app: AppHandle) {
    if let Err(error) = try_tray_toggle(&app).await {
        let _ = app.emit(
            "lifecycle-progress",
            serde_json::json!({ "stage": "error", "message": error }),
        );
    }
}

async fn try_tray_toggle(app: &AppHandle) -> Result<(), String> {
    let desktop = state::load(&state::path(app)?)?;
    if desktop.app_mode == state::AppMode::Unconfigured {
        return Err("Choose a role before starting Ray from the tray".into());
    }
    let manager = app.state::<lifecycle::LifecycleManager>();
    let role = match desktop.app_mode {
        state::AppMode::Coordinator => "Coordinator",
        state::AppMode::Worker => "Worker",
        state::AppMode::Unconfigured => "RayLab",
    };
    let current = lifecycle::status(app, &desktop.lifecycle, desktop.app_mode).await;
    let action = if current.state == "running" {
        lifecycle::stop(app, manager.inner(), desktop.lifecycle, desktop.app_mode)
            .await
            .map(|_| format!("{role} stopped"))
    } else {
        lifecycle::start(app, manager.inner(), desktop.lifecycle, desktop.app_mode)
            .await
            .map(|_| format!("{role} started"))
    };
    let message = action.map_err(|error| format!("Tray action failed: {error}"))?;
    let _ = app.emit(
        "lifecycle-progress",
        serde_json::json!({ "stage": "notice", "message": format!("{message} from the system tray") }),
    );
    Ok(())
}
