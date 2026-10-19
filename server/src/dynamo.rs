//! DynamoDB as the Store (store.rs), over its JSON API with SigV4 signatures:
//! no AWS SDK, so the Lambda stays small and starts fast.
//!
//! One table per record type, named `<prefix><table>` ("html-bible-users"),
//! keyed by "id". `query(table, field, value)` reads the global secondary
//! index named after the field. Those indexes are eventually consistent, so
//! the store remembers what this request wrote and lays it over what it reads:
//! a vote just cast is in the counts of the same response. `flush` (the end of
//! a request) forgets it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::ids::{hex, iso, system_now_ms};
use crate::store::{Store, StoreError, StoreResult, Write};

/* ------------------------------------------------------------- signing */

#[derive(Clone)]
pub struct Credentials {
    pub key_id: String,
    pub secret: String,
    pub session_token: Option<String>,
}

impl Credentials {
    /// What Lambda gives its role (and `aws configure export-credentials --format env`).
    pub fn from_env() -> Option<Self> {
        let get = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        Some(Credentials { key_id: get("AWS_ACCESS_KEY_ID")?, secret: get("AWS_SECRET_ACCESS_KEY")?, session_token: get("AWS_SESSION_TOKEN") })
    }
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// AWS Signature Version 4 of a POST with no query: the Authorization header.
/// `path` is plain (no characters that need escaping), `headers` are lowercase
/// names with their values, `amz_date` is 20261018T120000Z.
pub fn authorization(credentials: &Credentials, region: &str, service: &str, path: &str, amz_date: &str, headers: &[(&str, &str)], payload: &[u8]) -> String {
    let mut sorted: Vec<(&str, &str)> = headers.to_vec();
    sorted.sort();
    let canonical_headers: String = sorted.iter().map(|(k, v)| format!("{k}:{}\n", v.trim())).collect();
    let signed_headers = sorted.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(";");
    let canonical_request = format!("POST\n{path}\n\n{canonical_headers}\n{signed_headers}\n{}", hex(&Sha256::digest(payload)));
    let date = &amz_date[..8];
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex(&Sha256::digest(canonical_request.as_bytes())));
    let key = [date, region, service, "aws4_request"].iter().fold(format!("AWS4{}", credentials.secret).into_bytes(), |key, part| hmac(&key, part));
    let signature = hex(&hmac(&key, &to_sign));
    format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}", credentials.key_id)
}

/// 20261018T120000Z
fn amz_date(ms: i64) -> String {
    iso(ms).replace(['-', ':'], "").split('.').next().unwrap_or_default().to_string() + "Z"
}

/* ------------------------------------------------- attribute values */

/// JSON → DynamoDB's typed attribute value.
pub fn to_attribute(value: &Value) -> Value {
    match value {
        Value::Null => json!({ "NULL": true }),
        Value::Bool(b) => json!({ "BOOL": b }),
        Value::Number(n) => json!({ "N": n.to_string() }),
        Value::String(s) => json!({ "S": s }),
        Value::Array(list) => json!({ "L": list.iter().map(to_attribute).collect::<Vec<_>>() }),
        Value::Object(map) => json!({ "M": map.iter().map(|(k, v)| (k.clone(), to_attribute(v))).collect::<Map<_, _>>() }),
    }
}

/// DynamoDB's attribute value → JSON. Numbers without a point or exponent are integers.
pub fn from_attribute(value: &Value) -> Value {
    let Some((kind, inner)) = value.as_object().and_then(|m| m.iter().next()) else {
        return Value::Null;
    };
    match kind.as_str() {
        "S" => inner.clone(),
        "N" => {
            let text = inner.as_str().unwrap_or("0");
            if text.contains(['.', 'e', 'E']) {
                text.parse::<f64>().map(|f| json!(f)).unwrap_or(Value::Null)
            } else {
                text.parse::<i64>().map(|i| json!(i)).unwrap_or(Value::Null)
            }
        }
        "BOOL" => inner.clone(),
        "L" => Value::Array(inner.as_array().into_iter().flatten().map(from_attribute).collect()),
        "M" => Value::Object(inner.as_object().into_iter().flatten().map(|(k, v)| (k.clone(), from_attribute(v))).collect()),
        _ => Value::Null,
    }
}

fn to_item(item: &Value) -> Value {
    Value::Object(item.as_object().into_iter().flatten().map(|(k, v)| (k.clone(), to_attribute(v))).collect())
}

fn from_item(item: &Value) -> Value {
    Value::Object(item.as_object().into_iter().flatten().map(|(k, v)| (k.clone(), from_attribute(v))).collect())
}

/* ------------------------------------------------------------ the client */

/// What a failed call says: its exception name ("ConditionalCheckFailedException"),
/// message and whole body (a cancelled transaction lists its reasons there).
pub struct Failure {
    pub kind: String,
    pub message: String,
    pub body: Value,
}

/// Signed JSON calls to AWS services in one region (DynamoDB, SSM).
pub struct Aws {
    region: String,
    credentials: Credentials,
    agent: ureq::Agent,
}

impl Aws {
    pub fn new(region: &str, credentials: Credentials) -> Self {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).timeout(Duration::from_secs(8)).build();
        Aws { region: region.into(), credentials, agent }
    }

    /// A signed POST to "<service>.<region>.amazonaws.com<path>"; retried on throttling and 5xx.
    fn send(&self, service: &str, path: &str, extra: &[(&str, &str)], payload: &[u8]) -> Result<ureq::Response, Failure> {
        let host = format!("{service}.{}.amazonaws.com", self.region);
        let mut attempt = 0;
        loop {
            let date = amz_date(system_now_ms());
            let mut headers = vec![("host", host.as_str()), ("x-amz-date", date.as_str())];
            headers.extend_from_slice(extra);
            if let Some(token) = &self.credentials.session_token {
                headers.push(("x-amz-security-token", token.as_str()));
            }
            let auth = authorization(&self.credentials, &self.region, service, path, &date, &headers, payload);
            let mut request = self.agent.post(&format!("https://{host}{path}"));
            for (name, value) in headers.iter().filter(|(name, _)| *name != "host") {
                request = request.set(name, value);
            }
            let (failure, retry) = match request.set("authorization", &auth).send_bytes(payload) {
                Ok(response) => return Ok(response),
                Err(ureq::Error::Status(status, response)) => {
                    let body: Value = response.into_json().unwrap_or(Value::Null);
                    let kind = body["__type"].as_str().unwrap_or("").rsplit('#').next().unwrap_or("").to_string();
                    let message = body["message"].as_str().or(body["Message"].as_str()).unwrap_or("").to_string();
                    let retry = status >= 500 || kind.contains("Throttling") || kind.contains("ThroughputExceeded");
                    (Failure { kind: if kind.is_empty() { format!("HTTP {status}") } else { kind }, message, body }, retry)
                }
                Err(error) => (Failure { kind: "Transport".into(), message: error.to_string(), body: Value::Null }, true),
            };
            attempt += 1;
            if !retry || attempt >= 3 {
                return Err(failure);
            }
            std::thread::sleep(Duration::from_millis(50 << attempt));
        }
    }

    /// A JSON API call with X-Amz-Target (DynamoDB, SSM).
    pub fn call(&self, service: &str, json_version: &str, target: &str, body: &Value) -> Result<Value, Failure> {
        let payload = serde_json::to_vec(body).expect("JSON values serialize");
        let content_type = format!("application/x-amz-json-{json_version}");
        let response = self.send(service, "/", &[("content-type", content_type.as_str()), ("x-amz-target", target)], &payload)?;
        response.into_json().map_err(|e| Failure { kind: "Decode".into(), message: e.to_string(), body: Value::Null })
    }

    /// Start a Lambda function and do not wait for it: AWS queues the event
    /// (and retries a failed run twice) and answers 202 at once.
    pub fn invoke_async(&self, function: &str, event: &Value) -> Result<(), String> {
        let payload = serde_json::to_vec(event).expect("JSON values serialize");
        let path = format!("/2015-03-31/functions/{function}/invocations");
        self.send("lambda", &path, &[("content-type", "application/json"), ("x-amz-invocation-type", "Event")], &payload)
            .map(|_| ())
            .map_err(|f| format!("Lambda Invoke {function}: {} {}", f.kind, f.message))
    }

    /// A SecureString from SSM Parameter Store, decrypted.
    pub fn parameter(&self, name: &str) -> Result<String, String> {
        let found = self
            .call("ssm", "1.1", "AmazonSSM.GetParameter", &json!({ "Name": name, "WithDecryption": true }))
            .map_err(|f| format!("SSM {name}: {} {}", f.kind, f.message))?;
        found["Parameter"]["Value"].as_str().map(str::to_string).ok_or_else(|| format!("SSM {name}: no value"))
    }
}

/* --------------------------------------------------------------- store */

pub struct DynamoStore {
    aws: Aws,
    prefix: String,
    /// What this request wrote: (table, id) → the item, or None when deleted.
    written: Mutex<HashMap<(String, String), Option<Value>>>,
}

impl DynamoStore {
    pub fn new(region: &str, prefix: &str, credentials: Credentials) -> Self {
        DynamoStore { aws: Aws::new(region, credentials), prefix: prefix.into(), written: Mutex::new(HashMap::new()) }
    }

    pub fn aws(&self) -> &Aws {
        &self.aws
    }

    fn table(&self, table: &str) -> String {
        format!("{}{table}", self.prefix)
    }

    fn call(&self, action: &str, body: &Value) -> Result<Value, Failure> {
        self.aws.call("dynamodb", "1.0", &format!("DynamoDB_20120810.{action}"), body)
    }

    fn checked(&self, action: &str, body: &Value) -> StoreResult<Value> {
        self.call(action, body).map_err(|f| StoreError(format!("DynamoDB {action}: {} {}", f.kind, f.message)))
    }

    fn remember(&self, table: &str, id: &str, item: Option<Value>) {
        self.written.lock().unwrap_or_else(|p| p.into_inner()).insert((table.into(), id.into()), item);
    }

    fn remembered(&self, table: &str, id: &str) -> Option<Option<Value>> {
        self.written.lock().unwrap_or_else(|p| p.into_inner()).get(&(table.to_string(), id.to_string())).cloned()
    }

    /// Items read from an index or a scan, with this request's own writes laid over them.
    fn overlay(&self, table: &str, items: Vec<Value>, keep: impl Fn(&Value) -> bool) -> Vec<Value> {
        let written = self.written.lock().unwrap_or_else(|p| p.into_inner());
        let mine = |item: &Value| item["id"].as_str().is_some_and(|id| written.contains_key(&(table.to_string(), id.to_string())));
        let mut out: Vec<Value> = items.into_iter().filter(|item| !mine(item)).collect();
        out.extend(written.iter().filter(|((t, _), _)| t == table).filter_map(|(_, item)| item.clone()).filter(|item| keep(item)));
        out
    }

    /// Every page of a Query or Scan.
    fn pages(&self, action: &str, mut body: Value) -> StoreResult<Vec<Value>> {
        let mut items = Vec::new();
        loop {
            let page = self.checked(action, &body)?;
            items.extend(page["Items"].as_array().into_iter().flatten().map(from_item));
            match page.get("LastEvaluatedKey") {
                Some(key) if !key.is_null() => body["ExclusiveStartKey"] = key.clone(),
                _ => return Ok(items),
            }
        }
    }
}

fn id_of(item: &Value) -> StoreResult<String> {
    item["id"].as_str().map(str::to_string).ok_or_else(|| StoreError("items need a string id".into()))
}

impl Store for DynamoStore {
    fn get(&self, table: &str, id: &str) -> StoreResult<Option<Value>> {
        if let Some(item) = self.remembered(table, id) {
            return Ok(item);
        }
        let found = self.checked("GetItem", &json!({ "TableName": self.table(table), "Key": { "id": { "S": id } }, "ConsistentRead": true }))?;
        Ok(found.get("Item").filter(|i| !i.is_null()).map(from_item))
    }

    fn put(&self, table: &str, item: Value) -> StoreResult<()> {
        let id = id_of(&item)?;
        self.checked("PutItem", &json!({ "TableName": self.table(table), "Item": to_item(&item) }))?;
        self.remember(table, &id, Some(item));
        Ok(())
    }

    fn insert(&self, table: &str, item: Value) -> StoreResult<bool> {
        let id = id_of(&item)?;
        let body = json!({ "TableName": self.table(table), "Item": to_item(&item), "ConditionExpression": "attribute_not_exists(id)" });
        match self.call("PutItem", &body) {
            Ok(_) => {
                self.remember(table, &id, Some(item));
                Ok(true)
            }
            Err(failure) if failure.kind == "ConditionalCheckFailedException" => Ok(false),
            Err(failure) => Err(StoreError(format!("DynamoDB PutItem: {} {}", failure.kind, failure.message))),
        }
    }

    fn put_if(&self, table: &str, item: Value, field: &str, expected: &Value) -> StoreResult<bool> {
        let id = id_of(&item)?;
        let mut body = json!({ "TableName": self.table(table), "Item": to_item(&item), "ExpressionAttributeNames": { "#f": field } });
        if expected.is_null() {
            body["ConditionExpression"] = json!("attribute_not_exists(#f)");
        } else {
            body["ConditionExpression"] = json!("#f = :e");
            body["ExpressionAttributeValues"] = json!({ ":e": to_attribute(expected) });
        }
        match self.call("PutItem", &body) {
            Ok(_) => {
                self.remember(table, &id, Some(item));
                Ok(true)
            }
            Err(failure) if failure.kind == "ConditionalCheckFailedException" => Ok(false),
            Err(failure) => Err(StoreError(format!("DynamoDB PutItem: {} {}", failure.kind, failure.message))),
        }
    }

    fn increment(&self, table: &str, id: &str, field: &str) -> StoreResult<i64> {
        let updated = self.checked(
            "UpdateItem",
            &json!({
                "TableName": self.table(table),
                "Key": { "id": { "S": id } },
                "UpdateExpression": "ADD #f :one",
                "ExpressionAttributeNames": { "#f": field },
                "ExpressionAttributeValues": { ":one": { "N": "1" } },
                "ReturnValues": "UPDATED_NEW",
            }),
        )?;
        self.written.lock().unwrap_or_else(|p| p.into_inner()).remove(&(table.to_string(), id.to_string()));
        from_attribute(&updated["Attributes"][field]).as_i64().ok_or_else(|| StoreError(format!("DynamoDB UpdateItem: no {field}")))
    }

    fn transact(&self, writes: &[Write]) -> StoreResult<Option<usize>> {
        let items: Vec<Value> = writes
            .iter()
            .map(|w| {
                let mut put = json!({ "TableName": self.table(w.table), "Item": to_item(&w.item) });
                if w.new {
                    put["ConditionExpression"] = json!("attribute_not_exists(id)");
                }
                json!({ "Put": put })
            })
            .collect();
        match self.call("TransactWriteItems", &json!({ "TransactItems": items })) {
            Ok(_) => {
                for write in writes {
                    self.remember(write.table, &id_of(&write.item)?, Some(write.item.clone()));
                }
                Ok(None)
            }
            Err(failure) if failure.kind == "TransactionCanceledException" => {
                let reasons = failure.body["CancellationReasons"].as_array().cloned().unwrap_or_default();
                match reasons.iter().position(|r| r["Code"] == "ConditionalCheckFailed") {
                    Some(index) => Ok(Some(index)),
                    None => Err(StoreError(format!("DynamoDB TransactWriteItems: {}", failure.message))),
                }
            }
            Err(failure) => Err(StoreError(format!("DynamoDB TransactWriteItems: {} {}", failure.kind, failure.message))),
        }
    }

    fn delete(&self, table: &str, id: &str) -> StoreResult<bool> {
        let gone = self.checked("DeleteItem", &json!({ "TableName": self.table(table), "Key": { "id": { "S": id } }, "ReturnValues": "ALL_OLD" }))?;
        let existed = gone.get("Attributes").is_some_and(|a| !a.is_null()) || matches!(self.remembered(table, id), Some(Some(_)));
        self.remember(table, id, None);
        Ok(existed)
    }

    fn query(&self, table: &str, field: &str, value: &str) -> StoreResult<Vec<Value>> {
        let items = self.pages(
            "Query",
            json!({
                "TableName": self.table(table),
                "IndexName": field,
                "KeyConditionExpression": "#k = :v",
                "ExpressionAttributeNames": { "#k": field },
                "ExpressionAttributeValues": { ":v": { "S": value } },
            }),
        )?;
        Ok(self.overlay(table, items, |item| item[field].as_str() == Some(value)))
    }

    fn scan(&self, table: &str) -> StoreResult<Vec<Value>> {
        let items = self.pages("Scan", json!({ "TableName": self.table(table), "ConsistentRead": true }))?;
        Ok(self.overlay(table, items, |_| true))
    }

    fn clear(&self) -> StoreResult<()> {
        Err(StoreError("clearing is for the local store only".into()))
    }

    fn flush(&self) -> StoreResult<()> {
        self.written.lock().unwrap_or_else(|p| p.into_inner()).clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes_round_trip() {
        let item = json!({ "id": "x", "n": 3, "f": 0.6, "neg": -1, "t": true, "none": null, "list": ["a", 1], "map": { "s": "" } });
        let back = from_item(&to_item(&item));
        assert_eq!(back, item);
        assert!(back["f"].is_f64() && back["n"].is_i64());
    }

    /// AWS's SigV4 test suite ("post-vanilla"), and a DynamoDB call computed
    /// independently with Python's hmac and hashlib.
    #[test]
    fn signature() {
        let credentials = Credentials { key_id: "AKIDEXAMPLE".into(), secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(), session_token: None };
        let vanilla = authorization(&credentials, "us-east-1", "service", "/", "20150830T123600Z", &[("host", "example.amazonaws.com"), ("x-amz-date", "20150830T123600Z")], b"");
        assert_eq!(
            vanilla,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, \
             Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"
        );
        let headers = [("content-type", "application/x-amz-json-1.0"), ("host", "dynamodb.eu-central-1.amazonaws.com"), ("x-amz-date", "20261018T120000Z"), ("x-amz-target", "DynamoDB_20120810.GetItem")];
        let auth = authorization(&credentials, "eu-central-1", "dynamodb", "/", "20261018T120000Z", &headers, b"{}");
        assert!(auth.ends_with("Signature=cd85a10ceeee8141be3d5e020fc24fb73b263eb4fe9f7ebf86f96086aa81341d"));
        assert_eq!(amz_date(crate::ids::parse_iso("2026-10-18T12:00:00.000Z").unwrap()), "20261018T120000Z");
    }
}
