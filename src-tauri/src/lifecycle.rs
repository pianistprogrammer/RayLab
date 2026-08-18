use std::env;
use std::collections::HashSet;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, TcpListener, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};

use crate::ray_api::RayApiClient;
use crate::state::{AppMode, LifecycleConfig};

pub const MANAGED_CLUSTER_ID: &str = "raylab-managed-cluster";
pub const RAY_VERSION: &str = "2.57.0";
const PYTHON_VERSION: &str = "3.11";
const PROCESS_TIMEOUT: Duration = Duration::from_secs(90);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const VERIFY_TIMEOUT: Duration = Duration::from_secs(45);
const NODE_MANAGER_PORT: u16 = 8077;
const OBJECT_MANAGER_PORT: u16 = 8076;
const DASHBOARD_AGENT_HTTP_PORT: u16 = 52365;
const DASHBOARD_AGENT_GRPC_PORT: u16 = 52366;
const RUNTIME_ENV_AGENT_PORT: u16 = 52367;
const WORKER_PORT_MIN: u16 = 20000;
const WORKER_PORT_MAX: u16 = 20100;

#[derive(Default)]
pub struct LifecycleManager {
    operation: Mutex<()>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeStatus {
    pub ready: bool,
    pub installing_supported: bool,
    pub ray_version: Option<String>,
    pub ray_path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LifecycleStatus {
    pub state: String,
    pub mode: AppMode,
    pub message: String,
    pub local_node_ip: String,
    pub join_address: String,
    pub dashboard_url: String,
    pub runtime: RuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClusterTokenStatus {
    pub configured: bool,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LifecycleMarker {
    mode: AppMode,
    node_ip: String,
    dashboard_url: String,
    ray_path: String,
}

struct ProcessResult {
    success: bool,
    output: String,
}

pub async fn runtime_status(app: &AppHandle) -> RuntimeStatus {
    runtime_status_at(&runtime_root(app)).await
}

pub async fn install_runtime(
    app: &AppHandle,
    manager: &LifecycleManager,
) -> Result<RuntimeStatus, String> {
    let _guard = manager.operation.lock().await;
    let root = runtime_root(app);
    let existing = runtime_status_at(&root).await;
    if existing.ready {
        return Ok(existing);
    }

    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create the RayLab runtime directory: {error}"))?;
    let venv = managed_venv(&root);
    let python = managed_python(&root);

    if let Some(uv) = resolve_tool("uv") {
        let create = run_process(
            &uv,
            &[
                "venv".into(),
                path_text(&venv),
                "--python".into(),
                PYTHON_VERSION.into(),
                "--managed-python".into(),
                "--clear".into(),
            ],
            &[],
            INSTALL_TIMEOUT,
        )
        .await?;
        if !create.success {
            return Err(format!(
                "Could not create the managed Python runtime: {}",
                create.output
            ));
        }
        let install = run_process(
            &uv,
            &[
                "pip".into(),
                "install".into(),
                "--python".into(),
                path_text(&python),
                format!("ray[default]=={RAY_VERSION}"),
            ],
            &[],
            INSTALL_TIMEOUT,
        )
        .await?;
        if !install.success {
            return Err(format!("Could not install Ray: {}", install.output));
        }
    } else {
        let system_python = resolve_tool("python3").or_else(|| resolve_tool("python"));
        let Some(system_python) = system_python else {
            return Err(
                "RayLab needs uv or Python 3.10+ to create its managed Ray runtime. Install uv, then retry setup."
                    .into(),
            );
        };
        let create = run_process(
            &system_python,
            &[
                "-m".into(),
                "venv".into(),
                "--clear".into(),
                path_text(&venv),
            ],
            &[],
            INSTALL_TIMEOUT,
        )
        .await?;
        if !create.success {
            return Err(format!(
                "Could not create the managed Python runtime: {}",
                create.output
            ));
        }
        let install = run_process(
            &python,
            &[
                "-m".into(),
                "pip".into(),
                "install".into(),
                format!("ray[default]=={RAY_VERSION}"),
            ],
            &[],
            INSTALL_TIMEOUT,
        )
        .await?;
        if !install.success {
            return Err(format!("Could not install Ray: {}", install.output));
        }
    }

    let installed = runtime_status_at(&root).await;
    if installed.ready {
        Ok(installed)
    } else {
        Err(installed.message)
    }
}

pub async fn status(app: &AppHandle, config: &LifecycleConfig, mode: AppMode) -> LifecycleStatus {
    let runtime = runtime_status(app).await;
    let local_node_ip = effective_node_ip(config, mode);
    let join_address = format!(
        "{}:{}",
        effective_head_host(config, mode, &local_node_ip),
        config.ray_port
    );
    let dashboard_url = dashboard_url(config, mode, &local_node_ip);
    let marker = read_marker(&marker_path(app));

    if mode == AppMode::Unconfigured {
        return LifecycleStatus {
            state: "stopped".into(),
            mode,
            message: "Choose Coordinator or Worker mode".into(),
            local_node_ip,
            join_address,
            dashboard_url,
            runtime,
        };
    }

    let Some(marker) = marker else {
        return LifecycleStatus {
            state: "stopped".into(),
            mode,
            message: match mode {
                AppMode::Coordinator => "Coordinator is stopped".into(),
                AppMode::Worker => "This machine is not sharing resources".into(),
                AppMode::Unconfigured => unreachable!(),
            },
            local_node_ip,
            join_address,
            dashboard_url,
            runtime,
        };
    };

    if marker.mode != mode {
        return LifecycleStatus {
            state: "error".into(),
            mode,
            message: "A RayLab-managed Ray node is still running in the other mode. Stop it before switching roles.".into(),
            local_node_ip: marker.node_ip,
            join_address,
            dashboard_url: marker.dashboard_url,
            runtime,
        };
    }

    let token = if config.auth_enabled {
        match load_cluster_token(app, MANAGED_CLUSTER_ID) {
            Ok(Some(token)) => Some(token),
            Ok(None) => {
                return LifecycleStatus {
                    state: "error".into(),
                    mode,
                    message: "Cluster authentication is enabled but no token is configured".into(),
                    local_node_ip: marker.node_ip,
                    join_address,
                    dashboard_url: marker.dashboard_url,
                    runtime,
                }
            }
            Err(error) => {
                return LifecycleStatus {
                    state: "error".into(),
                    mode,
                    message: error,
                    local_node_ip: marker.node_ip,
                    join_address,
                    dashboard_url: marker.dashboard_url,
                    runtime,
                }
            }
        }
    } else {
        None
    };

    let running = verify_running(
        mode,
        &marker.dashboard_url,
        &marker.node_ip,
        token.as_deref(),
    )
    .await;
    LifecycleStatus {
        state: if running { "running" } else { "error" }.into(),
        mode,
        message: if running {
            match mode {
                AppMode::Coordinator => "Coordinator is accepting workers".into(),
                AppMode::Worker => "This machine is sharing resources".into(),
                AppMode::Unconfigured => unreachable!(),
            }
        } else {
            "RayLab previously started this node, but it is no longer visible to the cluster. Stop it to clean up, then start again.".into()
        },
        local_node_ip: marker.node_ip,
        join_address,
        dashboard_url: marker.dashboard_url,
        runtime,
    }
}

pub async fn start(
    app: &AppHandle,
    manager: &LifecycleManager,
    config: LifecycleConfig,
    mode: AppMode,
) -> Result<LifecycleStatus, String> {
    let _guard = manager.operation.lock().await;
    validate_config(&config, mode)?;
    if mode == AppMode::Unconfigured {
        return Err("Choose Coordinator or Worker mode before starting Ray".into());
    }

    let current = status(app, &config, mode).await;
    if current.state == "running" {
        return Ok(current);
    }
    if let Some(marker) = read_marker(&marker_path(app)) {
        if marker.mode != mode {
            return Err("Stop the RayLab-managed node before switching roles".into());
        }
    }

    let runtime = runtime_status(app).await;
    if !runtime.ready {
        return Err(format!(
            "{} Install the managed runtime first.",
            runtime.message
        ));
    }
    let ray_path = runtime
        .ray_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| "Ray executable is unavailable".to_string())?;

    let token_path = if config.auth_enabled {
        if load_cluster_token(app, MANAGED_CLUSTER_ID)?.is_none() {
            return Err("Configure the shared cluster token before starting Ray".into());
        }
        Some(cluster_token_path(app, MANAGED_CLUSTER_ID)?)
    } else {
        None
    };

    check_local_ports(&config, mode)?;
    let node_ip = effective_node_ip(&config, mode);
    if mode == AppMode::Coordinator && node_ip.parse::<Ipv4Addr>().is_ok_and(|ip| ip.is_loopback()) {
        return Err("RayLab could not detect a LAN address for workers. Enter this machine's private IPv4 address in Node IP override, then retry.".into());
    }
    let head_host = effective_head_host(&config, mode, &node_ip);
    let dashboard_url = format!("http://{head_host}:{}", config.dashboard_port);
    let data_root = ray_data_root(app);
    fs::create_dir_all(&data_root)
        .map_err(|error| format!("Could not create Ray data directory: {error}"))?;
    let args = build_start_args(&config, mode, &node_ip, &data_root);
    let environment = ray_environment(token_path.as_deref(), config.auth_enabled);
    let result = run_process(&ray_path, &args, &environment, PROCESS_TIMEOUT).await?;
    if !result.success {
        return Err(format!("Ray could not start: {}", result.output));
    }

    let marker = LifecycleMarker {
        mode,
        node_ip: node_ip.clone(),
        dashboard_url: dashboard_url.clone(),
        ray_path: path_text(&ray_path),
    };
    if let Err(error) = write_marker(&marker_path(app), &marker) {
        let _ = run_process(
            &ray_path,
            &["stop".into(), "--force".into()],
            &environment,
            PROCESS_TIMEOUT,
        )
        .await;
        return Err(format!(
            "Ray started but lifecycle ownership could not be recorded, so RayLab stopped it again: {error}"
        ));
    }

    let token = load_cluster_token(app, MANAGED_CLUSTER_ID)?;
    let deadline = tokio::time::Instant::now() + VERIFY_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if verify_running(mode, &dashboard_url, &node_ip, token.as_deref()).await {
            return Ok(status(app, &config, mode).await);
        }
        sleep(Duration::from_millis(750)).await;
    }

    let _ = run_process(
        &ray_path,
        &["stop".into(), "--force".into()],
        &environment,
        PROCESS_TIMEOUT,
    )
    .await;
    let _ = fs::remove_file(marker_path(app));
    Err(match mode {
        AppMode::Coordinator => "Ray started but its Dashboard did not become healthy in time".into(),
        AppMode::Worker => "Ray started locally, but this worker did not appear in the coordinator's State API. Check the join address, token, firewall, and Ray version.".into(),
        AppMode::Unconfigured => unreachable!(),
    })
}

pub async fn stop(
    app: &AppHandle,
    manager: &LifecycleManager,
    config: LifecycleConfig,
    mode: AppMode,
) -> Result<LifecycleStatus, String> {
    let _guard = manager.operation.lock().await;
    let marker_path = marker_path(app);
    let Some(marker) = read_marker(&marker_path) else {
        return Ok(status(app, &config, mode).await);
    };
    if marker.mode != mode {
        return Err("The running Ray node uses a different role. Switch back to that role before stopping it.".into());
    }
    let ray_path = PathBuf::from(&marker.ray_path);
    if !ray_path.is_file() {
        return Err(format!(
            "The Ray executable used to start this node is missing: {}",
            marker.ray_path
        ));
    }
    let token_path = if config.auth_enabled {
        Some(cluster_token_path(app, MANAGED_CLUSTER_ID)?)
    } else {
        None
    };
    let result = run_process(
        &ray_path,
        &["stop".into(), "--force".into()],
        &ray_environment(token_path.as_deref(), config.auth_enabled),
        PROCESS_TIMEOUT,
    )
    .await?;
    if !result.success {
        return Err(format!("Ray could not stop cleanly: {}", result.output));
    }
    fs::remove_file(&marker_path).map_err(|error| {
        format!("Ray stopped, but its lifecycle marker could not be removed: {error}")
    })?;
    Ok(status(app, &config, mode).await)
}

pub fn ensure_role_change_allowed(app: &AppHandle, next: AppMode) -> Result<(), String> {
    ensure_role_change_allowed_at(&marker_path(app), next)
}

fn ensure_role_change_allowed_at(path: &Path, next: AppMode) -> Result<(), String> {
    if let Some(marker) = read_marker(path) {
        if marker.mode != next {
            return Err(
                "Stop the running Ray node before switching Coordinator/Worker mode".into(),
            );
        }
    }
    Ok(())
}

pub fn ensure_lifecycle_change_allowed(app: &AppHandle) -> Result<(), String> {
    if read_marker(&marker_path(app)).is_some() {
        return Err("Stop the running Ray node before changing lifecycle settings".into());
    }
    Ok(())
}

pub fn ensure_cluster_token(
    app: &AppHandle,
    cluster_id: &str,
) -> Result<ClusterTokenStatus, String> {
    if let Some(token) = load_cluster_token(app, cluster_id)? {
        return Ok(ClusterTokenStatus {
            configured: true,
            token: Some(token),
        });
    }
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    save_cluster_token(app, cluster_id, &token)
}

pub fn save_cluster_token(
    app: &AppHandle,
    cluster_id: &str,
    token: &str,
) -> Result<ClusterTokenStatus, String> {
    let token = token.trim();
    if token.len() < 16 {
        return Err("Cluster tokens must contain at least 16 characters".into());
    }
    let path = cluster_token_path(app, cluster_id)?;
    write_private(&path, token.as_bytes())?;
    Ok(ClusterTokenStatus {
        configured: true,
        token: Some(token.to_string()),
    })
}

pub fn reveal_cluster_token(
    app: &AppHandle,
    cluster_id: &str,
) -> Result<ClusterTokenStatus, String> {
    let token = load_cluster_token(app, cluster_id)?;
    Ok(ClusterTokenStatus {
        configured: token.is_some(),
        token,
    })
}

pub fn load_cluster_token(app: &AppHandle, cluster_id: &str) -> Result<Option<String>, String> {
    let path = cluster_token_path(app, cluster_id)?;
    load_token_at(&path)
}

fn validate_config(config: &LifecycleConfig, mode: AppMode) -> Result<(), String> {
    if mode == AppMode::Worker {
        validate_host(&config.head_host)?;
    }
    if !config.node_ip_address.trim().is_empty()
        && config.node_ip_address.trim().parse::<Ipv4Addr>().is_err()
    {
        return Err(
            "Node IP must be a valid IPv4 address or left blank for automatic detection".into(),
        );
    }
    if !config.cpus.is_finite() || config.cpus < 0.0 {
        return Err("Shared CPUs must be zero or greater".into());
    }
    if !config.gpus.is_finite() || config.gpus < 0.0 {
        return Err("Shared GPUs must be zero or greater".into());
    }
    if config.max_concurrent_jobs == 0 {
        return Err("Maximum concurrent jobs must be at least one".into());
    }
    if mode == AppMode::Coordinator {
        let configured = [config.ray_port, config.dashboard_port, config.client_port];
        if configured.into_iter().collect::<HashSet<_>>().len() != configured.len() {
            return Err("Ray head, Dashboard, and Ray Client ports must be different".into());
        }
        let reserved = [
            NODE_MANAGER_PORT,
            OBJECT_MANAGER_PORT,
            DASHBOARD_AGENT_HTTP_PORT,
            DASHBOARD_AGENT_GRPC_PORT,
            RUNTIME_ENV_AGENT_PORT,
        ];
        if configured.iter().any(|port| reserved.contains(port) || (WORKER_PORT_MIN..=WORKER_PORT_MAX).contains(port)) {
            return Err("Configured coordinator ports overlap RayLab's fixed node, agent, or worker ports".into());
        }
    }
    Ok(())
}

fn validate_host(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 253
        || value.contains(char::is_whitespace)
        || value.contains('/')
        || value.contains('@')
        || value.contains(':')
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
    {
        return Err(
            "Coordinator host must be an IPv4 address or DNS hostname without a scheme or port"
                .into(),
        );
    }
    Ok(())
}

fn build_start_args(
    config: &LifecycleConfig,
    mode: AppMode,
    node_ip: &str,
    data_root: &Path,
) -> Vec<String> {
    let mut args = vec!["start".into()];
    match mode {
        AppMode::Coordinator => {
            args.push("--head".into());
            args.extend(["--port".into(), config.ray_port.to_string()]);
            args.extend(["--dashboard-host".into(), "0.0.0.0".into()]);
            args.extend(["--dashboard-port".into(), config.dashboard_port.to_string()]);
            args.extend([
                "--ray-client-server-port".into(),
                config.client_port.to_string(),
            ]);
        }
        AppMode::Worker => {
            args.extend([
                "--address".into(),
                format!("{}:{}", config.head_host.trim(), config.ray_port),
            ]);
        }
        AppMode::Unconfigured => return args,
    }
    args.extend(["--node-ip-address".into(), node_ip.into()]);
    args.extend(["--node-manager-port".into(), NODE_MANAGER_PORT.to_string()]);
    args.extend([
        "--object-manager-port".into(),
        OBJECT_MANAGER_PORT.to_string(),
    ]);
    args.extend([
        "--dashboard-agent-listen-port".into(),
        DASHBOARD_AGENT_HTTP_PORT.to_string(),
    ]);
    args.extend([
        "--dashboard-agent-grpc-port".into(),
        DASHBOARD_AGENT_GRPC_PORT.to_string(),
    ]);
    args.extend([
        "--runtime-env-agent-port".into(),
        RUNTIME_ENV_AGENT_PORT.to_string(),
    ]);
    args.extend(["--min-worker-port".into(), WORKER_PORT_MIN.to_string()]);
    args.extend(["--max-worker-port".into(), WORKER_PORT_MAX.to_string()]);
    args.extend(["--num-cpus".into(), config.cpus.floor().to_string()]);
    args.extend(["--num-gpus".into(), config.gpus.floor().to_string()]);
    args.extend([
        "--resources".into(),
        serde_json::json!({ "raylab_max_jobs": config.max_concurrent_jobs }).to_string(),
    ]);
    args.extend(["--temp-dir".into(), path_text(data_root)]);
    args
}

fn ray_environment(token_path: Option<&Path>, auth_enabled: bool) -> Vec<(String, String)> {
    let mut values = Vec::new();
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        values.push(("RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER".into(), "1".into()));
    }
    if auth_enabled {
        values.push(("RAY_AUTH_MODE".into(), "token".into()));
        if let Some(path) = token_path {
            values.push(("RAY_AUTH_TOKEN_PATH".into(), path_text(path)));
        }
    } else {
        values.push(("RAY_AUTH_MODE".into(), "disabled".into()));
    }
    values
}

fn check_local_ports(config: &LifecycleConfig, mode: AppMode) -> Result<(), String> {
    let mut ports = vec![
        NODE_MANAGER_PORT,
        OBJECT_MANAGER_PORT,
        DASHBOARD_AGENT_HTTP_PORT,
        DASHBOARD_AGENT_GRPC_PORT,
        RUNTIME_ENV_AGENT_PORT,
    ];
    if mode == AppMode::Coordinator {
        ports.extend([config.ray_port, config.dashboard_port, config.client_port]);
    }
    for port in ports {
        TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).map_err(|error| {
            format!("Port {port} is unavailable on this machine: {error}. Stop the conflicting service, then retry.")
        })?;
    }
    Ok(())
}

async fn verify_running(
    mode: AppMode,
    dashboard_url: &str,
    node_ip: &str,
    token: Option<&str>,
) -> bool {
    let Ok(client) = RayApiClient::with_token(dashboard_url, token) else {
        return false;
    };
    match mode {
        AppMode::Coordinator => client.version().await.is_ok(),
        AppMode::Worker => client.list_nodes().await.is_ok_and(|nodes| {
            nodes.iter().any(|node| {
                node.address == node_ip && matches!(node.status.as_str(), "ALIVE" | "RUNNING")
            })
        }),
        AppMode::Unconfigured => false,
    }
}

async fn runtime_status_at(root: &Path) -> RuntimeStatus {
    let ray = resolve_ray(root);
    let Some(ray) = ray else {
        return RuntimeStatus {
            ready: false,
            installing_supported: resolve_tool("uv").is_some()
                || resolve_tool("python3").is_some()
                || resolve_tool("python").is_some(),
            ray_version: None,
            ray_path: None,
            message: format!("Managed Ray {RAY_VERSION} is not installed"),
        };
    };
    let version = executable_version(&ray).await;
    let ready = version.as_deref() == Some(RAY_VERSION);
    RuntimeStatus {
        ready,
        installing_supported: true,
        ray_version: version.clone(),
        ray_path: Some(path_text(&ray)),
        message: if ready {
            format!("Ray {RAY_VERSION} is ready")
        } else {
            format!(
                "Ray version {} is incompatible; RayLab requires {RAY_VERSION}",
                version.unwrap_or_else(|| "unknown".into())
            )
        },
    }
}

async fn executable_version(path: &Path) -> Option<String> {
    let result = run_process(path, &["--version".into()], &[], Duration::from_secs(20))
        .await
        .ok()?;
    if !result.success {
        return None;
    }
    result
        .output
        .split_whitespace()
        .rev()
        .find(|part| {
            part.chars()
                .next()
                .is_some_and(|value| value.is_ascii_digit())
        })
        .map(|value| value.trim().trim_start_matches('v').to_string())
}

async fn run_process(
    program: &Path,
    args: &[String],
    environment: &[(String, String)],
    process_timeout: Duration,
) -> Result<ProcessResult, String> {
    let mut command = Command::new(program);
    command.args(args).kill_on_drop(true);
    for (key, value) in environment {
        command.env(key, value);
    }
    let output = timeout(process_timeout, command.output())
        .await
        .map_err(|_| format!("{} timed out", display_program(program)))?
        .map_err(|error| format!("Could not launch {}: {error}", display_program(program)))?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(ProcessResult {
        success: output.status.success(),
        output: bounded_tail(&combined, 1600),
    })
}

fn resolve_ray(root: &Path) -> Option<PathBuf> {
    let managed = managed_ray(root);
    if managed.is_file() {
        return Some(managed);
    }
    if let Some(explicit) = env::var_os("RAYLAB_RAY_BIN").map(PathBuf::from) {
        if explicit.is_file() {
            return Some(explicit);
        }
    }
    None
}

fn resolve_tool(name: &str) -> Option<PathBuf> {
    let executable = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    if let Some(paths) = env::var_os("PATH") {
        for directory in env::split_paths(&paths) {
            let candidate = directory.join(&executable);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if !cfg!(windows) {
        for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            let candidate = Path::new(directory).join(&executable);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if let Some(home) = env::var_os("HOME") {
            let candidate = PathBuf::from(home).join(".local/bin").join(&executable);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn runtime_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| env::temp_dir().join("raylab"))
        .join("runtime")
        .join(format!("ray-{RAY_VERSION}"))
}

fn managed_venv(root: &Path) -> PathBuf {
    root.join("venv")
}

fn managed_ray(root: &Path) -> PathBuf {
    if cfg!(windows) {
        managed_venv(root).join("Scripts/ray.exe")
    } else {
        managed_venv(root).join("bin/ray")
    }
}

fn managed_python(root: &Path) -> PathBuf {
    if cfg!(windows) {
        managed_venv(root).join("Scripts/python.exe")
    } else {
        managed_venv(root).join("bin/python")
    }
}

fn ray_data_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| env::temp_dir().join("raylab"))
        .join("ray-data")
}

fn marker_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| env::temp_dir().join("raylab"))
        .join("lifecycle.json")
}

fn write_marker(path: &Path, marker: &LifecycleMarker) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(marker)
        .map_err(|error| format!("Could not encode Ray lifecycle state: {error}"))?;
    write_private(path, &bytes)
}

fn read_marker(path: &Path) -> Option<LifecycleMarker> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn cluster_token_path(app: &AppHandle, cluster_id: &str) -> Result<PathBuf, String> {
    validate_cluster_id(cluster_id)?;
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve RayLab data directory: {error}"))?
        .join("secrets")
        .join(format!("{cluster_id}.token")))
}

fn validate_cluster_id(cluster_id: &str) -> Result<(), String> {
    if cluster_id.is_empty()
        || cluster_id.len() > 100
        || !cluster_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid cluster identifier".into());
    }
    Ok(())
}

fn load_token_at(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let token = fs::read_to_string(path)
        .map_err(|error| format!("Could not read the cluster token: {error}"))?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err("The stored cluster token is empty".into());
    }
    Ok(Some(token))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create the secrets directory: {error}"))?;
    }
    fs::write(path, bytes).map_err(|error| format!("Could not write private app data: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not protect private app data: {error}"))?;
    }
    Ok(())
}

fn effective_node_ip(config: &LifecycleConfig, mode: AppMode) -> String {
    let configured = config.node_ip_address.trim();
    if configured.parse::<Ipv4Addr>().is_ok() {
        return configured.to_string();
    }
    if mode == AppMode::Worker {
        if let Some(address) = route_ip(&config.head_host, config.ray_port) {
            return address;
        }
    }
    detect_lan_ip().unwrap_or_else(|| "127.0.0.1".into())
}

fn effective_head_host(config: &LifecycleConfig, mode: AppMode, node_ip: &str) -> String {
    if mode == AppMode::Coordinator {
        node_ip.to_string()
    } else {
        config.head_host.trim().to_string()
    }
}

fn dashboard_url(config: &LifecycleConfig, mode: AppMode, node_ip: &str) -> String {
    format!(
        "http://{}:{}",
        effective_head_host(config, mode, node_ip),
        config.dashboard_port
    )
}

fn route_ip(host: &str, port: u16) -> Option<String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((host, port)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() => Some(ip.to_string()),
        _ => None,
    }
}

fn detect_lan_ip() -> Option<String> {
    route_ip("1.1.1.1", 80)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn display_program(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("process")
        .to_string()
}

fn bounded_tail(value: &str, limit: usize) -> String {
    let value = value.trim();
    let mut characters: Vec<char> = value.chars().collect();
    if characters.len() > limit {
        characters.drain(..characters.len() - limit);
    }
    let result: String = characters.into_iter().collect();
    if result.is_empty() {
        "No diagnostic output was produced".into()
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinator_arguments_are_typed_and_expose_join_services() {
        let config = LifecycleConfig::default();
        let args = build_start_args(
            &config,
            AppMode::Coordinator,
            "10.0.0.8",
            Path::new("/tmp/raylab-data"),
        );
        assert_eq!(args[0], "start");
        assert!(args.contains(&"--head".to_string()));
        assert!(args
            .windows(2)
            .any(|part| part == ["--node-ip-address", "10.0.0.8"]));
        assert!(args
            .windows(2)
            .any(|part| part == ["--dashboard-host", "0.0.0.0"]));
        assert!(!args
            .iter()
            .any(|part| part.contains(';') || part.contains("&&")));
    }

    #[test]
    fn worker_arguments_join_exact_coordinator_address() {
        let config = LifecycleConfig {
            head_host: "10.0.0.8".into(),
            cpus: 6.0,
            gpus: 1.0,
            ..LifecycleConfig::default()
        };
        let args = build_start_args(
            &config,
            AppMode::Worker,
            "10.0.0.9",
            Path::new("/tmp/raylab-data"),
        );
        assert!(args
            .windows(2)
            .any(|part| part == ["--address", "10.0.0.8:6379"]));
        assert!(args.windows(2).any(|part| part == ["--num-cpus", "6"]));
        assert!(args.windows(2).any(|part| part == ["--num-gpus", "1"]));
        assert!(!args.contains(&"--head".to_string()));
    }

    #[test]
    fn invalid_worker_hosts_are_rejected_before_process_launch() {
        for host in ["http://10.0.0.8", "10.0.0.8:6379", "$(touch bad)", ""] {
            let config = LifecycleConfig {
                head_host: host.into(),
                ..LifecycleConfig::default()
            };
            assert!(validate_config(&config, AppMode::Worker).is_err());
        }
    }

    #[test]
    fn coordinator_ports_cannot_overlap_each_other_or_fixed_node_ports() {
        let duplicate = LifecycleConfig {
            dashboard_port: 6379,
            ..LifecycleConfig::default()
        };
        assert!(validate_config(&duplicate, AppMode::Coordinator).is_err());

        let reserved = LifecycleConfig {
            ray_port: NODE_MANAGER_PORT,
            ..LifecycleConfig::default()
        };
        assert!(validate_config(&reserved, AppMode::Coordinator).is_err());
    }

    #[test]
    fn cluster_identifiers_cannot_escape_the_secrets_directory() {
        assert!(validate_cluster_id("cluster-123").is_ok());
        assert!(validate_cluster_id("../token").is_err());
        assert!(validate_cluster_id("cluster/token").is_err());
    }

    #[test]
    fn token_files_round_trip_without_whitespace() {
        let path = env::temp_dir().join(format!("raylab-token-test-{}", std::process::id()));
        write_private(&path, b"abcdefghijklmnop\n").expect("write token");
        assert_eq!(
            load_token_at(&path).unwrap().as_deref(),
            Some("abcdefghijklmnop")
        );
        fs::remove_file(path).expect("remove token fixture");
    }

    #[test]
    fn active_markers_block_switching_to_the_other_role() {
        let path =
            env::temp_dir().join(format!("raylab-lifecycle-role-test-{}", std::process::id()));
        write_marker(
            &path,
            &LifecycleMarker {
                mode: AppMode::Coordinator,
                node_ip: "10.0.0.20".into(),
                dashboard_url: "http://10.0.0.20:8265".into(),
                ray_path: "/managed/ray".into(),
            },
        )
        .expect("write marker");
        assert!(ensure_role_change_allowed_at(&path, AppMode::Coordinator).is_ok());
        assert!(ensure_role_change_allowed_at(&path, AppMode::Worker).is_err());
        fs::remove_file(path).expect("remove marker fixture");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_arguments_never_pass_through_a_shell() {
        let side_effect =
            env::temp_dir().join(format!("raylab-shell-side-effect-{}", std::process::id()));
        let literal = format!("$(touch {})", side_effect.display());
        let result = run_process(
            Path::new("/usr/bin/printf"),
            &["%s".into(), literal.clone()],
            &[],
            Duration::from_secs(5),
        )
        .await
        .expect("run printf");
        assert!(result.success);
        assert_eq!(result.output, literal);
        assert!(!side_effect.exists());
    }
}
