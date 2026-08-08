from __future__ import annotations

import os
import signal
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .diagnostics import diagnostics, has_ray, ray_version, worker_account_setup_commands
from .discovery import detect_lan_ip, discover_coordinators, is_loopback_host
from .hardware import detect_hardware
from .installer import RayInstaller
from .models import AppConfig, AppMode, AuditEvent, ClusterState, HealthResponse, JobResponse, JobSubmission, SubmitterCreate, SubmitterWithToken
from .ray_control import RayController
from .setup_runner import SetupRunner
from .storage import ConfigStore, SecretStore


store = ConfigStore()
secrets = SecretStore()
controller = RayController(store, secrets)
ray_installer = RayInstaller(store)
setup_runner = SetupRunner(store)

app = FastAPI(title="RayLab Sidecar", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def api_error(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True, version=__version__, ray_available=has_ray(), ray_version=ray_version(), diagnostics=[])


@app.get("/config", response_model=AppConfig)
def get_config() -> AppConfig:
    return store.load()


@app.put("/config", response_model=AppConfig)
def put_config(config: AppConfig) -> AppConfig:
    current = store.load()
    if current.app_mode != AppMode.unconfigured and config.app_mode != current.app_mode:
        state = controller.status().state
        if state not in {ClusterState.stopped, ClusterState.error}:
            raise HTTPException(status_code=409, detail="Stop Ray before switching Host/Join mode.")
    if config.app_mode == AppMode.coordinator and config.coordinator.allow_external_workers and is_loopback_host(config.coordinator.head_host):
        lan_ip = detect_lan_ip()
        if lan_ip:
            config.coordinator.head_host = lan_ip
            if not config.coordinator.node_ip_address.strip():
                config.coordinator.node_ip_address = lan_ip
    store.save(config)
    store.append_audit(AuditEvent(event_type="config_updated", actor="owner", message="Configuration updated"))
    return store.load()


@app.post("/cluster/start")
def start_cluster() -> Any:
    try:
        return controller.start()
    except Exception as exc:
        raise api_error(exc) from exc


@app.post("/cluster/stop")
def stop_cluster() -> Any:
    try:
        return controller.stop(panic=False)
    except Exception as exc:
        raise api_error(exc) from exc


@app.post("/cluster/panic")
def panic_cluster() -> Any:
    try:
        return controller.stop(panic=True)
    except Exception as exc:
        raise api_error(exc) from exc


@app.get("/cluster/status")
def cluster_status() -> Any:
    return controller.status()


@app.get("/terminal/logs")
def terminal_logs() -> Any:
    return controller.terminal_logs()


@app.get("/diagnostics")
def get_diagnostics() -> Any:
    return diagnostics(store.load())


@app.get("/hardware")
def hardware() -> Any:
    return detect_hardware()


@app.get("/discovery/coordinators")
def discovery_coordinators() -> Any:
    return discover_coordinators(store.load())


@app.get("/setup/worker-account")
def setup_commands() -> Any:
    return [command.__dict__ for command in worker_account_setup_commands(store.load().privacy.worker_account)]


@app.get("/setup/ray-install")
def ray_install_status() -> Any:
    return ray_installer.status()


@app.post("/setup/ray-install")
def install_ray() -> Any:
    return ray_installer.start()


@app.get("/setup/run")
def setup_run_status() -> Any:
    return setup_runner.status()


@app.post("/setup/run")
def run_full_setup() -> Any:
    return setup_runner.start()


@app.get("/nodes")
def nodes() -> Any:
    return controller.nodes()


@app.post("/jobs", response_model=JobResponse)
def submit_job(job: JobSubmission) -> JobResponse:
    try:
        return controller.submit_job(job)
    except Exception as exc:
        raise api_error(exc) from exc


@app.post("/jobs/{job_id}/kill", response_model=JobResponse)
def kill_job(job_id: str) -> JobResponse:
    try:
        return controller.kill_job(job_id)
    except Exception as exc:
        raise api_error(exc) from exc


@app.get("/audit")
def audit() -> Any:
    return store.load().audit


@app.post("/submitters", response_model=SubmitterWithToken)
def create_submitter(payload: SubmitterCreate) -> SubmitterWithToken:
    import secrets as token_secrets

    config = store.load()
    from .models import Submitter

    submitter = Submitter(name=payload.name)
    token = token_secrets.token_urlsafe(32)
    secrets.set(submitter.token_ref, token)
    config.submitters.append(submitter)
    store.save(config)
    store.append_audit(AuditEvent(event_type="submitter_created", actor="coordinator", message=f"Created submitter {payload.name}"))
    return SubmitterWithToken(**submitter.model_dump(), token=token)


@app.post("/submitters/{submitter_id}/revoke")
def revoke_submitter(submitter_id: str) -> AppConfig:
    config = store.load()
    for submitter in config.submitters:
        if submitter.id == submitter_id:
            submitter.revoked = True
            store.save(config)
            store.append_audit(AuditEvent(event_type="submitter_revoked", actor="coordinator", message=f"Revoked submitter {submitter.name}"))
            return store.load()
    raise HTTPException(status_code=404, detail="Submitter not found")


@app.post("/shutdown")
def shutdown() -> dict[str, str]:
    if os.environ.get("RAYLAB_ALLOW_SHUTDOWN", "1") == "1":
        os.kill(os.getpid(), signal.SIGTERM)
    return {"status": "shutdown requested"}
