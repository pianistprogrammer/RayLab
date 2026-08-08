from __future__ import annotations

from datetime import datetime, time
from enum import Enum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator, model_validator


MANAGED_WORKER_ACCOUNT = "raylab-worker"


class AppMode(str, Enum):
    unconfigured = "unconfigured"
    coordinator = "coordinator"
    node = "node"


class ClusterState(str, Enum):
    stopped = "stopped"
    starting = "starting"
    running = "running"
    stopping = "stopping"
    error = "error"


class ScheduleWindow(BaseModel):
    days: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4], description="0=Monday, 6=Sunday")
    start: time = Field(default=time(22, 0))
    end: time = Field(default=time(7, 0))

    @field_validator("days")
    @classmethod
    def validate_days(cls, value: list[int]) -> list[int]:
        if any(day < 0 or day > 6 for day in value):
            raise ValueError("schedule days must be between 0 and 6")
        return sorted(set(value))


class NodePolicy(BaseModel):
    master_enabled: bool = False
    manual_override: Literal["auto", "force_on", "force_off", "panic"] = "auto"
    schedule_enabled: bool = False
    schedule_windows: list[ScheduleWindow] = Field(default_factory=list)
    idle_only_enabled: bool = False
    idle_minutes: int = Field(default=10, ge=1, le=240)
    max_cpu_percent_for_idle: int = Field(default=20, ge=1, le=100)
    max_gpu_percent_for_idle: int = Field(default=10, ge=0, le=100)


class ResourceCaps(BaseModel):
    cpus: float = Field(default=4, gt=0)
    gpus: float = Field(default=1, ge=0)
    memory_gb: float = Field(default=16, gt=0)
    gpu_memory_gb: float = Field(default=12, ge=0)
    max_concurrent_jobs: int = Field(default=1, ge=1, le=64)

    @property
    def memory_bytes(self) -> int:
        return int(self.memory_gb * 1024 * 1024 * 1024)


class CoordinatorConfig(BaseModel):
    head_host: str = "127.0.0.1"
    dashboard_host: str = "127.0.0.1"
    node_ip_address: str = ""
    ray_port: int = Field(default=6379, ge=1, le=65535)
    dashboard_port: int = Field(default=8265, ge=1, le=65535)
    client_port: int = Field(default=10001, ge=1, le=65535)
    node_manager_port: int = Field(default=8076, ge=1, le=65535)
    object_manager_port: int = Field(default=8077, ge=1, le=65535)
    cluster_token_ref: str = "raylab.cluster_token"
    dashboard_token_ref: str = "raylab.dashboard_token"
    bind_private_only: bool = True
    allow_external_workers: bool = False

    @property
    def ray_address(self) -> str:
        return f"{self.head_host}:{self.ray_port}"

    @property
    def dashboard_url(self) -> str:
        return f"http://{self.head_host}:{self.dashboard_port}"


class PrivacyConfig(BaseModel):
    worker_account: str = MANAGED_WORKER_ACCOUNT
    worker_account_required: bool = True
    allow_home_access: bool = False
    require_runtime_working_dir: bool = True
    container_runtime: Literal["docker", "podman"] = "docker"
    require_gpu_container_runtime: bool = True


class ObjectStoreConfig(BaseModel):
    endpoint_url: str = ""
    bucket: str = ""
    region: str = ""
    access_key_ref: str = "raylab.object_store_access_key"
    secret_key_ref: str = "raylab.object_store_secret_key"


class Submitter(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    token_ref: str = Field(default_factory=lambda: f"raylab.submitter.{uuid4()}")
    revoked: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)


class AuditEvent(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    event_type: str
    actor: str = "system"
    message: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class AppConfig(BaseModel):
    app_mode: AppMode = AppMode.unconfigured
    coordinator: CoordinatorConfig = Field(default_factory=CoordinatorConfig)
    node_policy: NodePolicy = Field(default_factory=NodePolicy)
    resource_caps: ResourceCaps = Field(default_factory=ResourceCaps)
    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)
    object_store: ObjectStoreConfig = Field(default_factory=ObjectStoreConfig)
    submitters: list[Submitter] = Field(default_factory=list)
    audit: list[AuditEvent] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_privacy_contract(self) -> "AppConfig":
        self.privacy.worker_account = MANAGED_WORKER_ACCOUNT
        if self.privacy.worker_account_required and self.privacy.allow_home_access:
            raise ValueError("worker account mode cannot allow owner home-directory access")
        return self


class HealthResponse(BaseModel):
    ok: bool
    version: str
    ray_available: bool
    ray_version: str | None = None
    diagnostics: list[str] = Field(default_factory=list)


class InstallStatus(BaseModel):
    running: bool = False
    succeeded: bool | None = None
    message: str = "Not started"
    command: list[str] = Field(default_factory=list)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    log_tail: list[str] = Field(default_factory=list)


class SetupTask(BaseModel):
    id: str
    label: str
    status: Literal["pending", "running", "pass", "warn", "fail", "skipped"] = "pending"
    detail: str = "Waiting"
    fix: str | None = None


class SetupRunStatus(BaseModel):
    running: bool = False
    succeeded: bool | None = None
    can_continue: bool = False
    progress: int = Field(default=0, ge=0, le=100)
    message: str = "Not started"
    started_at: datetime | None = None
    finished_at: datetime | None = None
    tasks: list[SetupTask] = Field(default_factory=list)


class DiagnosticCheck(BaseModel):
    id: str
    label: str
    status: Literal["pass", "warn", "fail"]
    detail: str
    fix: str | None = None


class HardwareInfo(BaseModel):
    cpu_logical: int
    cpu_physical: int | None = None
    memory_total_gb: float | None = None
    gpu_count: int
    gpu_names: list[str] = Field(default_factory=list)
    gpu_type: str = "none"
    gpu_memory_total_gb: float | None = None
    gpu_memory_shared: bool = False
    source: str = "psutil"


class TerminalLogEntry(BaseModel):
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    stream: str = "system"
    message: str


class DiscoveryCandidate(BaseModel):
    host: str
    ray_port: int
    dashboard_port: int | None = None
    dashboard_url: str | None = None
    confidence: int = Field(default=0, ge=0, le=100)
    detail: str


class ClusterStatus(BaseModel):
    state: ClusterState = ClusterState.stopped
    mode: AppMode = AppMode.unconfigured
    address: str | None = None
    dashboard_url: str | None = None
    message: str = "Not started"
    diagnostics: list[DiagnosticCheck] = Field(default_factory=list)


class NodeInfo(BaseModel):
    node_id: str
    hostname: str
    status: str
    owner: str = "unknown"
    cpus_total: float = 0
    gpus_total: float = 0
    memory_total_gb: float = 0
    cpu_percent: float = 0
    gpu_percent: float = 0
    ram_percent: float = 0
    last_seen: datetime = Field(default_factory=datetime.utcnow)


class JobSubmission(BaseModel):
    submitter_id: str
    entrypoint: str = Field(min_length=1)
    working_dir: str = Field(min_length=1)
    runtime_env: dict[str, Any] = Field(default_factory=dict)
    container_image: str | None = None
    metadata: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def require_working_dir_in_runtime_env(self) -> "JobSubmission":
        env = dict(self.runtime_env)
        env["working_dir"] = self.working_dir
        if self.container_image:
            env.setdefault("container", {"image": self.container_image})
        self.runtime_env = env
        return self


class JobResponse(BaseModel):
    job_id: str
    status: str
    message: str


class SubmitterCreate(BaseModel):
    name: str = Field(min_length=1)


class SubmitterWithToken(Submitter):
    token: str
