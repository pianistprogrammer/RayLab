import pytest

from raylab_sidecar.models import AppConfig, JobSubmission, MANAGED_WORKER_ACCOUNT


def test_privacy_contract_rejects_home_access_with_worker_account() -> None:
    data = AppConfig().model_dump()
    data["privacy"]["allow_home_access"] = True

    with pytest.raises(ValueError):
        AppConfig.model_validate(data)


def test_worker_account_name_is_managed() -> None:
    data = AppConfig().model_dump()
    data["privacy"]["worker_account"] = "custom-worker"

    config = AppConfig.model_validate(data)

    assert config.privacy.worker_account == MANAGED_WORKER_ACCOUNT


def test_job_submission_injects_working_dir_into_runtime_env() -> None:
    job = JobSubmission(submitter_id="person", entrypoint="python train.py", working_dir="s3://lab/jobs/1")

    assert job.runtime_env["working_dir"] == "s3://lab/jobs/1"
