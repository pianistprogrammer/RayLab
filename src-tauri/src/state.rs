use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DesktopState {
    pub active_view: String,
    pub selected_cluster_id: Option<String>,
    pub selected_job_id: Option<String>,
    pub saved_clusters: Vec<SavedCluster>,
    pub preferences: Preferences,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            active_view: "overview".into(),
            selected_cluster_id: None,
            selected_job_id: None,
            saved_clusters: Vec::new(),
            preferences: Preferences::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SavedCluster {
    pub id: String,
    pub name: String,
    pub dashboard_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Preferences {
    pub auto_refresh: bool,
    pub poll_interval_ms: u64,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            auto_refresh: true,
            poll_interval_ms: 5000,
        }
    }
}

pub fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("desktop-state.json"))
        .map_err(|error| format!("Could not resolve RayLab app data directory: {error}"))
}

pub fn load(path: &Path) -> Result<DesktopState, String> {
    if !path.exists() {
        return Ok(DesktopState::default());
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not read RayLab desktop state: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("RayLab desktop state is invalid: {error}"))
}

pub fn save(path: &Path, state: &DesktopState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create RayLab app data directory: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Could not encode RayLab desktop state: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("Could not save RayLab desktop state: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_state_uses_safe_defaults() {
        let path =
            std::env::temp_dir().join(format!("raylab-state-missing-{}.json", std::process::id()));
        let state = load(&path).expect("default state");
        assert_eq!(state.active_view, "overview");
        assert!(state.preferences.auto_refresh);
        assert_eq!(state.preferences.poll_interval_ms, 5000);
    }

    #[test]
    fn old_state_is_migrated_with_default_preferences() {
        let decoded: DesktopState = serde_json::from_str(
            r#"{"active_view":"jobs","selected_cluster_id":null,"selected_job_id":null,"saved_clusters":[]}"#,
        )
        .expect("state should decode");
        assert_eq!(decoded.active_view, "jobs");
        assert_eq!(decoded.preferences, Preferences::default());
    }
}
