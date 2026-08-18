use tauri::AppHandle;

use crate::ray_api::{
    ClusterInput, JobAction, JobSubmission, RayApiClient, RayApiVersion, RayJob, RayNode,
    SubmitJobResult,
};
use crate::state::{self, DesktopState};

#[tauri::command]
pub fn load_app_state(app: AppHandle) -> Result<DesktopState, String> {
    state::load(&state::path(&app)?)
}

#[tauri::command]
pub fn save_app_state(app: AppHandle, state: DesktopState) -> Result<DesktopState, String> {
    state::save(&state::path(&app)?, &state)?;
    Ok(state)
}

#[tauri::command]
pub async fn ray_api_version(cluster: ClusterInput) -> Result<RayApiVersion, String> {
    RayApiClient::new(&cluster.dashboard_url)?.version().await
}

#[tauri::command]
pub async fn list_jobs(cluster: ClusterInput) -> Result<Vec<RayJob>, String> {
    RayApiClient::new(&cluster.dashboard_url)?.list_jobs().await
}

#[tauri::command]
pub async fn get_job(cluster: ClusterInput, id: String) -> Result<RayJob, String> {
    RayApiClient::new(&cluster.dashboard_url)?
        .get_job(&id)
        .await
}

#[tauri::command]
pub async fn get_job_logs(cluster: ClusterInput, id: String) -> Result<String, String> {
    RayApiClient::new(&cluster.dashboard_url)?
        .job_logs(&id)
        .await
}

#[tauri::command]
pub async fn submit_job(
    cluster: ClusterInput,
    job: JobSubmission,
) -> Result<SubmitJobResult, String> {
    RayApiClient::new(&cluster.dashboard_url)?
        .submit_job(job)
        .await
}

#[tauri::command]
pub async fn stop_job(cluster: ClusterInput, id: String) -> Result<JobAction, String> {
    RayApiClient::new(&cluster.dashboard_url)?
        .stop_job(&id)
        .await
}

#[tauri::command]
pub async fn delete_job(cluster: ClusterInput, id: String) -> Result<JobAction, String> {
    RayApiClient::new(&cluster.dashboard_url)?
        .delete_job(&id)
        .await
}

#[tauri::command]
pub async fn list_nodes(cluster: ClusterInput) -> Result<Vec<RayNode>, String> {
    RayApiClient::new(&cluster.dashboard_url)?
        .list_nodes()
        .await
}
