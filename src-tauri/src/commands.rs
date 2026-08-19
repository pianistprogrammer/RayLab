use tauri::{AppHandle, State};

use crate::lifecycle::{
    self, ClusterTokenStatus, LifecycleManager, LifecycleStatus, RuntimeStatus,
};
use crate::ray_api::{
    ClusterInput, JobAction, JobSubmission, RayApiClient, RayApiVersion, RayJob, RayNode,
    SubmitJobResult,
};
use crate::state::{self, AppMode, DesktopState, LifecycleConfig};

#[tauri::command]
pub fn load_app_state(app: AppHandle) -> Result<DesktopState, String> {
    state::load(&state::path(&app)?)
}

#[tauri::command]
pub fn save_app_state(app: AppHandle, state: DesktopState) -> Result<DesktopState, String> {
    let current = state::load(&state::path(&app)?)?;
    if current.app_mode != state.app_mode {
        lifecycle::ensure_role_change_allowed(&app, state.app_mode)?;
    }
    if current.lifecycle != state.lifecycle {
        lifecycle::ensure_lifecycle_change_allowed(&app)?;
    }
    state::save(&state::path(&app)?, &state)?;
    Ok(state)
}

#[tauri::command]
pub async fn ray_api_version(
    app: AppHandle,
    cluster: ClusterInput,
) -> Result<RayApiVersion, String> {
    ray_client(&app, &cluster)?.version().await
}

#[tauri::command]
pub async fn list_jobs(app: AppHandle, cluster: ClusterInput) -> Result<Vec<RayJob>, String> {
    ray_client(&app, &cluster)?.list_jobs().await
}

#[tauri::command]
pub async fn get_job(app: AppHandle, cluster: ClusterInput, id: String) -> Result<RayJob, String> {
    ray_client(&app, &cluster)?.get_job(&id).await
}

#[tauri::command]
pub async fn get_job_logs(
    app: AppHandle,
    cluster: ClusterInput,
    id: String,
) -> Result<String, String> {
    ray_client(&app, &cluster)?.job_logs(&id).await
}

#[tauri::command]
pub async fn submit_job(
    app: AppHandle,
    cluster: ClusterInput,
    mut job: JobSubmission,
) -> Result<SubmitJobResult, String> {
    apply_managed_job_policy(&cluster.id, &mut job);
    ray_client(&app, &cluster)?.submit_job(job).await
}

#[tauri::command]
pub async fn stop_job(
    app: AppHandle,
    cluster: ClusterInput,
    id: String,
) -> Result<JobAction, String> {
    ray_client(&app, &cluster)?.stop_job(&id).await
}

#[tauri::command]
pub async fn delete_job(
    app: AppHandle,
    cluster: ClusterInput,
    id: String,
) -> Result<JobAction, String> {
    ray_client(&app, &cluster)?.delete_job(&id).await
}

#[tauri::command]
pub async fn list_nodes(app: AppHandle, cluster: ClusterInput) -> Result<Vec<RayNode>, String> {
    ray_client(&app, &cluster)?.list_nodes().await
}

#[tauri::command]
pub async fn ray_runtime_status(app: AppHandle) -> RuntimeStatus {
    lifecycle::runtime_status(&app).await
}

#[tauri::command]
pub fn detect_local_node_ip() -> Result<String, String> {
    lifecycle::local_node_ip()
}

#[tauri::command]
pub async fn install_ray_runtime(
    app: AppHandle,
    manager: State<'_, LifecycleManager>,
) -> Result<RuntimeStatus, String> {
    lifecycle::install_runtime(&app, manager.inner()).await
}

#[tauri::command]
pub async fn lifecycle_status(
    app: AppHandle,
    config: LifecycleConfig,
    mode: AppMode,
) -> LifecycleStatus {
    lifecycle::status(&app, &config, mode).await
}

#[tauri::command]
pub async fn start_lifecycle(
    app: AppHandle,
    manager: State<'_, LifecycleManager>,
    config: LifecycleConfig,
    mode: AppMode,
) -> Result<LifecycleStatus, String> {
    lifecycle::start(&app, manager.inner(), config, mode).await
}

#[tauri::command]
pub async fn stop_lifecycle(
    app: AppHandle,
    manager: State<'_, LifecycleManager>,
    config: LifecycleConfig,
    mode: AppMode,
) -> Result<LifecycleStatus, String> {
    lifecycle::stop(&app, manager.inner(), config, mode).await
}

#[tauri::command]
pub fn ensure_cluster_token(
    app: AppHandle,
    cluster_id: String,
) -> Result<ClusterTokenStatus, String> {
    lifecycle::ensure_cluster_token(&app, &cluster_id)
}

#[tauri::command]
pub fn save_cluster_token(
    app: AppHandle,
    cluster_id: String,
    token: String,
) -> Result<ClusterTokenStatus, String> {
    lifecycle::save_cluster_token(&app, &cluster_id, &token)
}

#[tauri::command]
pub fn reveal_cluster_token(
    app: AppHandle,
    cluster_id: String,
) -> Result<ClusterTokenStatus, String> {
    lifecycle::reveal_cluster_token(&app, &cluster_id)
}

fn ray_client(app: &AppHandle, cluster: &ClusterInput) -> Result<RayApiClient, String> {
    let token = if cluster.id.trim().is_empty() {
        None
    } else {
        lifecycle::load_cluster_token(app, &cluster.id)?
    };
    match token {
        Some(token) => RayApiClient::with_token(&cluster.dashboard_url, Some(&token)),
        None => RayApiClient::new(&cluster.dashboard_url),
    }
}

fn apply_managed_job_policy(cluster_id: &str, job: &mut JobSubmission) {
    if cluster_id == lifecycle::MANAGED_CLUSTER_ID {
        job.entrypoint_resources
            .get_or_insert_with(Default::default)
            .entry("raylab_max_jobs".into())
            .or_insert(1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn managed_jobs_consume_one_raylab_scheduler_slot() {
        let mut job = JobSubmission {
            entrypoint: "python train.py".into(),
            runtime_env: serde_json::json!({}),
            metadata: HashMap::new(),
            submission_id: None,
            entrypoint_num_cpus: None,
            entrypoint_num_gpus: None,
            entrypoint_resources: None,
        };
        apply_managed_job_policy(lifecycle::MANAGED_CLUSTER_ID, &mut job);
        assert_eq!(
            job.entrypoint_resources
                .as_ref()
                .and_then(|resources| resources.get("raylab_max_jobs")),
            Some(&1.0)
        );
    }
}
