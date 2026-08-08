use std::fs::{create_dir_all, read_dir, remove_dir_all, OpenOptions};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};

struct SidecarState {
    child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
}

#[derive(serde::Serialize)]
struct SidecarStatus {
    running: bool,
    error: Option<String>,
}

#[tauri::command]
fn open_dashboard(url: String) -> Result<(), String> {
    open_url(&url)
}

#[tauri::command]
fn sidecar_status(state: State<'_, SidecarState>) -> Result<SidecarStatus, String> {
    let error = state.last_error.lock().map_err(|_| "sidecar error lock poisoned".to_string())?.clone();
    let mut guard = state.child.lock().map_err(|_| "sidecar lock poisoned".to_string())?;
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                if sidecar_http_ready() {
                    Ok(SidecarStatus { running: true, error: None })
                } else {
                    Ok(SidecarStatus { running: false, error })
                }
            }
            Ok(None) => Ok(SidecarStatus { running: true, error }),
            Err(err) => Err(err.to_string()),
        }
    } else if sidecar_http_ready() {
        Ok(SidecarStatus { running: true, error: None })
    } else {
        Ok(SidecarStatus { running: false, error })
    }
}

fn sidecar_http_ready() -> bool {
    ureq::get("http://127.0.0.1:8765/health")
        .timeout(Duration::from_millis(500))
        .call()
        .map(|response| response.status() == 200)
        .unwrap_or(false)
}

fn sidecar_executable_path(path: std::path::PathBuf) -> Option<std::path::PathBuf> {
    if path.is_file() {
        return Some(path);
    }
    let executable = path.join("raylab-sidecar");
    if executable.is_file() {
        return Some(executable);
    }
    None
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", url]);
        cmd
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(url);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(url);
        cmd
    };

    command.spawn().map_err(|err| err.to_string())?;
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    create_dir_all(dst)?;
    for entry in read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn sidecar_port_available() -> bool {
    TcpListener::bind("127.0.0.1:8765").is_ok()
}

fn clear_stale_sidecar_port() -> Result<(), String> {
    if sidecar_port_available() {
        return Ok(());
    }
    let _ = ureq::post("http://127.0.0.1:8765/shutdown").timeout(Duration::from_millis(500)).call();
    for _ in 0..20 {
        if sidecar_port_available() {
            return Ok(());
        }
        sleep(Duration::from_millis(150));
    }
    Err("RayLab sidecar port 8765 is already in use. Quit the other RayLab instance or free 127.0.0.1:8765, then reopen RayLab.".to_string())
}

fn spawn_sidecar(app: &tauri::App) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    let mut guard = state.child.lock().map_err(|_| "sidecar lock poisoned".to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    clear_stale_sidecar_port()?;
    let resource_dir = app.path().resource_dir().ok();
    let resource_sidecar = resource_dir.as_ref().map(|dir| dir.join("sidecar"));
    let packaged_sidecar = resource_dir.as_ref().map(|dir| dir.join("_up_").join("sidecar"));
    let dev_sidecar = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")).join("sidecar");
    let project_sidecar = resource_sidecar
        .filter(|path| path.exists())
        .or_else(|| packaged_sidecar.filter(|path| path.exists()))
        .unwrap_or(dev_sidecar);
    let log_dir = std::env::temp_dir().join("raylab-cluster-manager");
    let _ = create_dir_all(&log_dir);
    let log_path = log_dir.join("sidecar.log");
    let stdio_for_log = || {
        let stdout = OpenOptions::new().create(true).append(true).open(&log_path).ok();
        let stderr = stdout.as_ref().and_then(|file| file.try_clone().ok());
        (
            stdout.map(Stdio::from).unwrap_or_else(Stdio::null),
            stderr.map(Stdio::from).unwrap_or_else(Stdio::null),
        )
    };
    let resource_binary = resource_dir.as_ref().map(|dir| dir.join("sidecar-bin").join("raylab-sidecar"));
    let packaged_binary = resource_dir.as_ref().map(|dir| dir.join("_up_").join("sidecar-bin").join("raylab-sidecar"));
    if let Some(binary) = resource_binary
        .filter(|path| path.exists())
        .or_else(|| packaged_binary.filter(|path| path.exists()))
        .and_then(sidecar_executable_path)
    {
        let (stdout, stderr) = stdio_for_log();
        let child = Command::new(binary)
            .env("PYTHONUNBUFFERED", "1")
            .current_dir(log_dir)
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .map_err(|err| format!("failed to spawn bundled sidecar: {err}"))?;
        *guard = Some(child);
        return Ok(());
    }

    let python = if cfg!(target_os = "windows") { "python" } else { "python3" };
    let runtime_sidecar = log_dir.join("sidecar-runtime");
    let _ = remove_dir_all(&runtime_sidecar);
    copy_dir_all(&project_sidecar, &runtime_sidecar).map_err(|err| format!("failed to stage sidecar: {err}"))?;
    let bootstrap = runtime_sidecar.join("run_sidecar.py");
    let mut command = if cfg!(target_os = "windows") {
        let mut cmd = Command::new(python);
        cmd.arg(&bootstrap);
        cmd
    } else {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-lc", "\"$RAYLAB_PYTHON\" \"$RAYLAB_BOOTSTRAP\" >> \"$RAYLAB_LOG\" 2>&1 &"]);
        cmd.env("RAYLAB_PYTHON", python);
        cmd.env("RAYLAB_BOOTSTRAP", bootstrap.as_os_str());
        cmd.env("RAYLAB_LOG", log_path.as_os_str());
        cmd
    };
    command
        .env("PYTHONUNBUFFERED", "1")
        .current_dir(runtime_sidecar);
    let (stdout, stderr) = stdio_for_log();
    command.stdout(stdout).stderr(stderr);
    let child = command
        .spawn()
        .map_err(|err| format!("failed to spawn sidecar: {err}"))?;
    *guard = Some(child);
    Ok(())
}

fn shutdown_sidecar(app: &AppHandle) {
    let _ = ureq::post("http://127.0.0.1:8765/shutdown").timeout(std::time::Duration::from_millis(500)).call();
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show RayLab", true, None::<&str>)?;
    let dashboard = MenuItem::with_id(app, "dashboard", "Open Dashboard", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &dashboard, &quit])?;
    TrayIconBuilder::new()
        .tooltip("RayLab")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "dashboard" => {
                let _ = open_url("http://127.0.0.1:8265");
            }
            "quit" => {
                shutdown_sidecar(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState { child: Mutex::new(None), last_error: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![open_dashboard, sidecar_status])
        .setup(|app| {
            build_tray(app)?;
            if let Err(err) = spawn_sidecar(app) {
                eprintln!("{err}");
                if let Ok(mut last_error) = app.state::<SidecarState>().last_error.lock() {
                    *last_error = Some(err);
                }
            } else if let Ok(mut last_error) = app.state::<SidecarState>().last_error.lock() {
                *last_error = None;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                shutdown_sidecar(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running RayLab");
}
