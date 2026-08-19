mod commands;
mod lifecycle;
mod ray_api;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(lifecycle::LifecycleManager::default())
        .plugin(tauri_plugin_opener::init())
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
            commands::ray_runtime_status,
            commands::install_ray_runtime,
            commands::lifecycle_status,
            commands::start_lifecycle,
            commands::stop_lifecycle,
            commands::ensure_cluster_token,
            commands::save_cluster_token,
            commands::reveal_cluster_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RayLab");
}
