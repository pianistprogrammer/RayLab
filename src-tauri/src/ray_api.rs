use std::collections::HashMap;
use std::time::Duration;

use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const ERROR_BODY_LIMIT: usize = 800;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterInput {
    #[serde(default)]
    pub id: String,
    pub dashboard_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RayApiVersion {
    pub version: String,
    pub ray_version: String,
    pub ray_commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RayJob {
    pub id: String,
    pub submission_id: String,
    pub job_id: String,
    pub job_type: String,
    pub entrypoint: String,
    pub status: String,
    pub message: String,
    pub error_type: Option<String>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub metadata: Value,
    pub runtime_env: Value,
    pub driver_info: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSubmission {
    pub entrypoint: String,
    #[serde(default = "empty_object")]
    pub runtime_env: Value,
    #[serde(default)]
    pub metadata: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submission_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entrypoint_num_cpus: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entrypoint_num_gpus: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entrypoint_resources: Option<HashMap<String, f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubmitJobResult {
    pub job_id: String,
    pub submission_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JobAction {
    pub id: String,
    pub status: String,
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RayNode {
    pub id: String,
    pub name: String,
    pub address: String,
    pub status: String,
    pub is_head: bool,
    pub cpus: f64,
    pub gpus: f64,
    pub memory_gb: f64,
}

pub struct RayApiClient {
    base_url: Url,
    client: Client,
    token: Option<String>,
}

impl RayApiClient {
    pub fn new(raw_url: &str) -> Result<Self, String> {
        Self::with_token(raw_url, None)
    }

    pub fn with_token(raw_url: &str, token: Option<&str>) -> Result<Self, String> {
        let mut base_url = Url::parse(raw_url.trim())
            .map_err(|error| format!("Invalid Ray Dashboard URL: {error}"))?;
        if !matches!(base_url.scheme(), "http" | "https") {
            return Err("Ray Dashboard URL must use http:// or https://".into());
        }
        if base_url.host_str().is_none() {
            return Err("Ray Dashboard URL must include a host".into());
        }
        if !base_url.username().is_empty() || base_url.password().is_some() {
            return Err("Ray Dashboard URL must not contain credentials".into());
        }
        base_url.set_path("/");
        base_url.set_query(None);
        base_url.set_fragment(None);

        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("Could not create Ray API client: {error}"))?;
        Ok(Self {
            base_url,
            client,
            token: token
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        })
    }

    pub async fn version(&self) -> Result<RayApiVersion, String> {
        let value = self.request(Method::GET, "/api/version", None).await?;
        Ok(RayApiVersion {
            version: string_field(&value, &["version"]),
            ray_version: string_field(&value, &["ray_version"]),
            ray_commit: string_field(&value, &["ray_commit"]),
        })
    }

    pub async fn list_jobs(&self) -> Result<Vec<RayJob>, String> {
        let value = self.request(Method::GET, "/api/jobs/", None).await?;
        decode_job_list(value)
    }

    pub async fn get_job(&self, id: &str) -> Result<RayJob, String> {
        let raw_id = id.trim();
        let encoded_id = validate_id(id)?;
        let value = self
            .request(Method::GET, &format!("/api/jobs/{encoded_id}"), None)
            .await?;
        decode_job(value, Some(raw_id))
    }

    pub async fn job_logs(&self, id: &str) -> Result<String, String> {
        let id = validate_id(id)?;
        let value = self
            .request(Method::GET, &format!("/api/jobs/{id}/logs"), None)
            .await?;
        Ok(value
            .get("logs")
            .and_then(Value::as_str)
            .or_else(|| value.as_str())
            .unwrap_or_default()
            .to_string())
    }

    pub async fn submit_job(&self, mut job: JobSubmission) -> Result<SubmitJobResult, String> {
        job.entrypoint = job.entrypoint.trim().to_string();
        if job.entrypoint.is_empty() {
            return Err("Job entrypoint is required".into());
        }
        if !job.runtime_env.is_object() {
            return Err("runtime_env must be a JSON object".into());
        }
        if job.entrypoint_num_cpus.is_some_and(|value| value < 0.0)
            || job.entrypoint_num_gpus.is_some_and(|value| value < 0.0)
            || job.entrypoint_resources.as_ref().is_some_and(|resources| {
                resources
                    .values()
                    .any(|value| !value.is_finite() || *value < 0.0)
            })
        {
            return Err("Entrypoint CPU and GPU reservations cannot be negative".into());
        }

        let payload = serde_json::to_value(job)
            .map_err(|error| format!("Could not encode job submission: {error}"))?;
        let value = self
            .request(Method::POST, "/api/jobs/", Some(payload))
            .await?;
        let submission_id = string_field(&value, &["submission_id", "job_id"]);
        if submission_id.is_empty() {
            return Err("Ray accepted the job but did not return a submission ID".into());
        }
        Ok(SubmitJobResult {
            job_id: submission_id.clone(),
            submission_id,
        })
    }

    pub async fn stop_job(&self, id: &str) -> Result<JobAction, String> {
        let raw_id = id.trim().to_string();
        let encoded_id = validate_id(id)?;
        let value = self
            .request(Method::POST, &format!("/api/jobs/{encoded_id}/stop"), None)
            .await?;
        let status = value
            .as_str()
            .or_else(|| value.get("status").and_then(Value::as_str))
            .unwrap_or("STOP_REQUESTED")
            .to_uppercase();
        let accepted = value
            .as_bool()
            .or_else(|| value.get("stopped").and_then(Value::as_bool))
            .unwrap_or(true);
        Ok(JobAction {
            id: raw_id,
            status,
            accepted,
        })
    }

    pub async fn delete_job(&self, id: &str) -> Result<JobAction, String> {
        let raw_id = id.trim().to_string();
        let encoded_id = validate_id(id)?;
        let value = self
            .request(Method::DELETE, &format!("/api/jobs/{encoded_id}"), None)
            .await?;
        let accepted = value
            .as_bool()
            .or_else(|| value.get("deleted").and_then(Value::as_bool))
            .unwrap_or(true);
        Ok(JobAction {
            id: raw_id,
            status: "DELETED".into(),
            accepted,
        })
    }

    pub async fn list_nodes(&self) -> Result<Vec<RayNode>, String> {
        let value = self
            .request(Method::GET, "/api/v0/nodes?detail=true&limit=10000", None)
            .await?;
        Ok(decode_nodes(&value))
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let url = self
            .base_url
            .join(path)
            .map_err(|error| format!("Could not build Ray API URL: {error}"))?;
        let mut request = self.client.request(method.clone(), url.clone());
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            format!(
                "Cannot reach the Ray Dashboard at {}: {}",
                self.base_url.origin().ascii_serialization(),
                request_error(&error)
            )
        })?;
        let status = response.status();
        let raw = response
            .text()
            .await
            .map_err(|error| format!("Could not read Ray API response: {error}"))?;
        if !status.is_success() {
            return Err(http_error(&method, path, status, &raw));
        }
        if raw.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&raw)
            .map_err(|error| format!("Ray API returned invalid JSON for {method} {path}: {error}"))
    }
}

fn decode_job_list(value: Value) -> Result<Vec<RayJob>, String> {
    match value {
        Value::Array(items) => items
            .into_iter()
            .map(|item| decode_job(item, None))
            .collect(),
        Value::Object(mut object) => {
            let source = match object.remove("jobs") {
                Some(Value::Object(jobs)) => jobs,
                Some(other) => return decode_job_list(other),
                None => object,
            };
            source
                .into_iter()
                .map(|(id, job)| decode_job(job, Some(&id)))
                .collect()
        }
        _ => Err("Ray Jobs API returned an unsupported job list".into()),
    }
}

fn decode_job(value: Value, fallback_id: Option<&str>) -> Result<RayJob, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Ray Jobs API returned an invalid job record".to_string())?;
    let submission_id = first_string(object, &["submission_id"])
        .or_else(|| fallback_id.map(str::to_string))
        .or_else(|| first_string(object, &["job_id"]))
        .unwrap_or_default();
    let job_id = first_string(object, &["job_id"]).unwrap_or_else(|| submission_id.clone());
    Ok(RayJob {
        id: if submission_id.is_empty() {
            job_id.clone()
        } else {
            submission_id.clone()
        },
        submission_id,
        job_id,
        job_type: first_string(object, &["type"]).unwrap_or_else(|| "SUBMISSION".into()),
        entrypoint: first_string(object, &["entrypoint"]).unwrap_or_default(),
        status: first_string(object, &["status"])
            .unwrap_or_else(|| "UNKNOWN".into())
            .to_uppercase(),
        message: first_string(object, &["message"]).unwrap_or_default(),
        error_type: first_string(object, &["error_type"]),
        start_time: number_field(object, "start_time"),
        end_time: number_field(object, "end_time"),
        metadata: object.get("metadata").cloned().unwrap_or_else(|| json!({})),
        runtime_env: object
            .get("runtime_env")
            .cloned()
            .unwrap_or_else(|| json!({})),
        driver_info: object
            .get("driver_info")
            .cloned()
            .filter(|value| !value.is_null()),
    })
}

fn decode_nodes(value: &Value) -> Vec<RayNode> {
    let candidates = value
        .pointer("/data/result/result")
        .or_else(|| value.pointer("/data/result"))
        .or_else(|| value.get("nodes"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    candidates
        .iter()
        .filter_map(|value| {
            let object = value.as_object()?;
            let id = first_string(object, &["node_id", "NodeID"])?;
            let address = first_string(
                object,
                &[
                    "node_ip",
                    "node_ip_address",
                    "node_manager_address",
                    "NodeManagerAddress",
                ],
            )
            .unwrap_or_default();
            let name = first_string(object, &["node_name", "nodeName", "hostname", "NodeName"])
                .unwrap_or_else(|| {
                    if address.is_empty() {
                        id.clone()
                    } else {
                        address.clone()
                    }
                });
            let resources = object
                .get("resources_total")
                .or_else(|| object.get("Resources"))
                .and_then(Value::as_object);
            let cpus = resource_number(resources, "CPU");
            let gpus = resource_number(resources, "GPU");
            let memory_gb = resource_number(resources, "memory") / 1024_f64.powi(3);
            Some(RayNode {
                id,
                name,
                address,
                status: first_string(object, &["state", "State", "status"])
                    .unwrap_or_else(|| "UNKNOWN".into())
                    .to_uppercase(),
                is_head: object
                    .get("is_head_node")
                    .or_else(|| object.get("IsHeadNode"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                cpus,
                gpus,
                memory_gb,
            })
        })
        .collect()
}

fn validate_id(id: &str) -> Result<String, String> {
    let value = id.trim();
    if value.is_empty() {
        return Err("Job ID is required".into());
    }
    let encoded: String = url_encode(value);
    Ok(encoded)
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn empty_object() -> Value {
    json!({})
}

fn first_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn string_field(value: &Value, keys: &[&str]) -> String {
    value
        .as_object()
        .and_then(|object| first_string(object, keys))
        .unwrap_or_default()
}

fn number_field(object: &Map<String, Value>, key: &str) -> Option<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
}

fn resource_number(resources: Option<&Map<String, Value>>, key: &str) -> f64 {
    resources
        .and_then(|resources| resources.get(key))
        .and_then(Value::as_f64)
        .unwrap_or_default()
}

fn request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "request timed out".into()
    } else if error.is_connect() {
        "connection failed".into()
    } else {
        error.to_string()
    }
}

fn http_error(method: &Method, path: &str, status: StatusCode, raw: &str) -> String {
    let parsed = serde_json::from_str::<Value>(raw).ok();
    let detail = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("detail")
                .or_else(|| value.get("message"))
                .or_else(|| value.get("error"))
        })
        .and_then(Value::as_str)
        .unwrap_or(raw)
        .trim();
    let detail: String = detail.chars().take(ERROR_BODY_LIMIT).collect();
    format!(
        "Ray API {method} {path} failed ({}): {}",
        status.as_u16(),
        if detail.is_empty() {
            "empty response"
        } else {
            &detail
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn normalizes_current_array_job_response() {
        let jobs = decode_job_list(json!([{
            "submission_id": "raysubmit_1",
            "job_id": "01000000",
            "status": "running",
            "entrypoint": "python train.py",
            "start_time": 1000
        }]))
        .expect("jobs");
        assert_eq!(jobs[0].id, "raysubmit_1");
        assert_eq!(jobs[0].status, "RUNNING");
        assert_eq!(jobs[0].job_id, "01000000");
    }

    #[test]
    fn normalizes_legacy_map_job_response() {
        let jobs = decode_job_list(json!({
            "raysubmit_old": {"status": "SUCCEEDED", "message": "done"}
        }))
        .expect("jobs");
        assert_eq!(jobs[0].submission_id, "raysubmit_old");
        assert_eq!(jobs[0].message, "done");
    }

    #[test]
    fn encodes_job_ids_before_building_paths() {
        assert_eq!(
            validate_id("job/with spaces").unwrap(),
            "job%2Fwith%20spaces"
        );
    }

    #[test]
    fn rejects_credentials_embedded_in_dashboard_urls() {
        let error = RayApiClient::new("https://token@example.test:8265")
            .err()
            .expect("credentials should reject");
        assert!(error.contains("must not contain credentials"));
    }

    #[test]
    fn decodes_state_api_nodes() {
        let nodes = decode_nodes(&json!({
            "data": {"result": {"result": [{
                "node_id": "node-1",
                "node_name": "worker-a",
                "node_ip": "10.0.0.2",
                "state": "ALIVE",
                "resources_total": {"CPU": 8, "GPU": 1, "memory": 17179869184_u64}
            }]}}
        }));
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "worker-a");
        assert_eq!(nodes[0].memory_gb, 16.0);
    }

    #[test]
    fn surfaces_structured_http_error_details() {
        let message = http_error(
            &Method::POST,
            "/api/jobs/",
            StatusCode::BAD_REQUEST,
            r#"{"detail":"working_dir is invalid"}"#,
        );
        assert!(message.contains("400"));
        assert!(message.contains("working_dir is invalid"));
    }

    #[tokio::test]
    async fn calls_the_jobs_rest_list_endpoint() {
        let (base_url, server) = serve_once(
            "GET /api/jobs/ HTTP/1.1",
            200,
            r#"[{"submission_id":"raysubmit_http","status":"RUNNING"}]"#,
        );
        let jobs = RayApiClient::new(&base_url)
            .unwrap()
            .list_jobs()
            .await
            .expect("HTTP job list");
        server.join().expect("mock server");
        assert_eq!(jobs[0].id, "raysubmit_http");
    }

    #[tokio::test]
    async fn submits_structured_json_to_the_jobs_api() {
        let (base_url, server) = serve_once(
            "POST /api/jobs/ HTTP/1.1",
            200,
            r#"{"submission_id":"training-42"}"#,
        );
        let result = RayApiClient::new(&base_url)
            .unwrap()
            .submit_job(JobSubmission {
                entrypoint: "python train.py".into(),
                runtime_env: json!({"working_dir": "s3://bucket/project.zip"}),
                metadata: HashMap::from([("team".into(), "vision".into())]),
                submission_id: Some("training-42".into()),
                entrypoint_num_cpus: Some(2.0),
                entrypoint_num_gpus: Some(1.0),
                entrypoint_resources: Some(HashMap::from([("raylab_max_jobs".into(), 1.0)])),
            })
            .await
            .expect("HTTP job submission");
        server.join().expect("mock server");
        assert_eq!(result.submission_id, "training-42");
    }

    #[tokio::test]
    async fn rejects_non_success_responses_from_ray() {
        let (base_url, server) = serve_once(
            "GET /api/version HTTP/1.1",
            503,
            r#"{"detail":"dashboard is starting"}"#,
        );
        let error = RayApiClient::new(&base_url)
            .unwrap()
            .version()
            .await
            .expect_err("503 should reject");
        server.join().expect("mock server");
        assert!(error.contains("503"));
        assert!(error.contains("dashboard is starting"));
    }

    #[tokio::test]
    async fn sends_bearer_tokens_without_putting_them_in_urls() {
        let (base_url, server) = serve_once_with_bearer(
            "GET /api/version HTTP/1.1",
            200,
            r#"{"version":"1","ray_version":"2.57.0","ray_commit":"abc"}"#,
            "private-ray-token",
        );
        let version = RayApiClient::with_token(&base_url, Some("private-ray-token"))
            .unwrap()
            .version()
            .await
            .expect("authenticated version request");
        server.join().expect("mock server");
        assert_eq!(version.ray_version, "2.57.0");
    }

    fn serve_once(
        expected_request_line: &'static str,
        status: u16,
        body: &'static str,
    ) -> (String, thread::JoinHandle<()>) {
        serve_once_internal(expected_request_line, status, body, None)
    }

    fn serve_once_with_bearer(
        expected_request_line: &'static str,
        status: u16,
        body: &'static str,
        bearer: &'static str,
    ) -> (String, thread::JoinHandle<()>) {
        serve_once_internal(expected_request_line, status, body, Some(bearer))
    }

    fn serve_once_internal(
        expected_request_line: &'static str,
        status: u16,
        body: &'static str,
        bearer: Option<&'static str>,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock address");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept mock request");
            let request = read_http_request(&mut stream);
            assert!(
                request.starts_with(expected_request_line),
                "unexpected request: {request}"
            );
            if let Some(bearer) = bearer {
                assert!(
                    request.to_ascii_lowercase().contains(&format!(
                        "authorization: bearer {}",
                        bearer.to_ascii_lowercase()
                    )),
                    "missing bearer header: {request}"
                );
            }
            if expected_request_line.starts_with("POST") {
                assert!(request.contains("\"entrypoint\":\"python train.py\""));
                assert!(request
                    .contains("\"runtime_env\":{\"working_dir\":\"s3://bucket/project.zip\"}"));
                assert!(request.contains("\"entrypoint_resources\":{\"raylab_max_jobs\":1.0}"));
            }
            let reason = if status < 300 { "OK" } else { "Error" };
            write!(
                stream,
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("write mock response");
        });
        (format!("http://{address}"), handle)
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let read = stream.read(&mut buffer).expect("read mock request");
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(str::trim)
                            .map(str::to_string)
                    })
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                if bytes.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }
        String::from_utf8(bytes).expect("UTF-8 mock request")
    }
}
