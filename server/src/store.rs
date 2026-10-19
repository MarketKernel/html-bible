//! The storage interface the core uses. Small on purpose, so DynamoDB can stand in:
//!
//! - every item is a JSON object with a string "id" (the partition key);
//! - `query(table, field, value)` is an equality lookup on one string attribute:
//!   in DynamoDB a GSI (arguments by questionId, votes by targetKey, …);
//! - `scan` is used only by the question list and verse tags;
//! - `insert` is a conditional write: it fails when the id exists (logins);
//! - `put_if` writes only while a field still has the value read before;
//! - `increment` raises a counter atomically and returns the new value;
//! - `transact` writes several items at once, all or none.
//!
//! `Db` puts typed records (model.rs) on top of it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use crate::errors::ApiError;
use crate::model::{Record, TABLES};

#[derive(Debug)]
pub struct StoreError(pub String);

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        eprintln!("[store] {}", error.0);
        crate::errors::internal()
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

/// One write of a transaction: an item, and whether its id must be new.
pub struct Write {
    pub table: &'static str,
    pub item: Value,
    pub new: bool,
}

pub trait Store: Send + Sync {
    fn get(&self, table: &str, id: &str) -> StoreResult<Option<Value>>;
    fn put(&self, table: &str, item: Value) -> StoreResult<()>;
    /// Put only if no item has this id; false when one has.
    fn insert(&self, table: &str, item: Value) -> StoreResult<bool>;
    fn delete(&self, table: &str, id: &str) -> StoreResult<bool>;
    /// Put only while `field` still equals `expected` (Null: the field is absent);
    /// false when it no longer does.
    fn put_if(&self, table: &str, item: Value, field: &str, expected: &Value) -> StoreResult<bool>;
    /// Add 1 to the number `field` of the item (made at 1 when missing); the new value.
    fn increment(&self, table: &str, id: &str, field: &str) -> StoreResult<i64>;
    /// All the writes or none: Some(i) when the i-th write's id was not new.
    fn transact(&self, writes: &[Write]) -> StoreResult<Option<usize>>;
    fn query(&self, table: &str, field: &str, value: &str) -> StoreResult<Vec<Value>>;
    fn scan(&self, table: &str) -> StoreResult<Vec<Value>>;
    /// Remove everything (local --reset and tests only).
    fn clear(&self) -> StoreResult<()>;
    /// Write out what changed; called once per request.
    fn flush(&self) -> StoreResult<()> {
        Ok(())
    }
}

/// Typed access over a Store.
pub struct Db<'a>(pub &'a dyn Store);

fn decode<T: Record>(value: Value) -> StoreResult<T> {
    serde_json::from_value(value).map_err(|e| StoreError(format!("{}: {e}", T::TABLE)))
}

fn encode<T: Record>(record: &T) -> StoreResult<Value> {
    serde_json::to_value(record).map_err(|e| StoreError(format!("{}: {e}", T::TABLE)))
}

impl Db<'_> {
    pub fn get<T: Record>(&self, id: &str) -> StoreResult<Option<T>> {
        self.0.get(T::TABLE, id)?.map(decode).transpose()
    }

    pub fn put<T: Record>(&self, record: &T) -> StoreResult<()> {
        self.0.put(T::TABLE, encode(record)?)
    }

    pub fn insert<T: Record>(&self, record: &T) -> StoreResult<bool> {
        self.0.insert(T::TABLE, encode(record)?)
    }

    pub fn put_if<T: Record>(&self, record: &T, field: &str, expected: &Value) -> StoreResult<bool> {
        self.0.put_if(T::TABLE, encode(record)?, field, expected)
    }

    pub fn delete<T: Record>(&self, id: &str) -> StoreResult<bool> {
        self.0.delete(T::TABLE, id)
    }

    pub fn query<T: Record>(&self, field: &str, value: &str) -> StoreResult<Vec<T>> {
        self.0.query(T::TABLE, field, value)?.into_iter().map(decode).collect()
    }

    pub fn scan<T: Record>(&self) -> StoreResult<Vec<T>> {
        self.0.scan(T::TABLE)?.into_iter().map(decode).collect()
    }
}

/// Every table in memory; with a directory, one JSON file per table there
/// (server/.data/ locally), rewritten atomically when it changed.
pub struct MemoryStore {
    directory: Option<PathBuf>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    tables: HashMap<String, BTreeMap<String, Value>>,
    dirty: BTreeSet<String>,
}

impl MemoryStore {
    pub fn new(directory: Option<PathBuf>) -> Self {
        MemoryStore { directory, state: Mutex::new(State::default()) }
    }

    fn with<R>(&self, table: &str, action: impl FnOnce(&mut BTreeMap<String, Value>, &mut BTreeSet<String>) -> R) -> StoreResult<R> {
        if !TABLES.contains(&table) {
            return Err(StoreError(format!("unknown table {table}")));
        }
        let mut state = self.state.lock().map_err(|_| StoreError("the store lock is poisoned".into()))?;
        let State { tables, dirty } = &mut *state;
        if !tables.contains_key(table) {
            let loaded = self.load(table)?;
            tables.insert(table.to_string(), loaded);
        }
        let items = tables.get_mut(table).expect("loaded above");
        Ok(action(items, dirty))
    }

    fn path(&self, table: &str) -> Option<PathBuf> {
        self.directory.as_ref().map(|dir| dir.join(format!("{table}.json")))
    }

    fn load(&self, table: &str) -> StoreResult<BTreeMap<String, Value>> {
        let Some(path) = self.path(table).filter(|p| p.exists()) else {
            return Ok(BTreeMap::new());
        };
        let text = fs::read_to_string(&path).map_err(|e| StoreError(format!("{}: {e}", path.display())))?;
        let items: Vec<Value> = serde_json::from_str(&text).map_err(|e| StoreError(format!("{}: {e}", path.display())))?;
        Ok(items.into_iter().filter_map(|item| Some((item.get("id")?.as_str()?.to_string(), item))).collect())
    }
}

impl Write {
    pub fn put<T: Record>(record: &T) -> StoreResult<Write> {
        Ok(Write { table: T::TABLE, item: encode(record)?, new: false })
    }

    pub fn insert<T: Record>(record: &T) -> StoreResult<Write> {
        Ok(Write { table: T::TABLE, item: encode(record)?, new: true })
    }
}

fn item_id(item: &Value) -> StoreResult<String> {
    item.get("id").and_then(Value::as_str).map(str::to_string).ok_or_else(|| StoreError("items need a string id".into()))
}

impl Store for MemoryStore {
    fn get(&self, table: &str, id: &str) -> StoreResult<Option<Value>> {
        self.with(table, |items, _| items.get(id).cloned())
    }

    fn put(&self, table: &str, item: Value) -> StoreResult<()> {
        let id = item_id(&item)?;
        self.with(table, |items, dirty| {
            items.insert(id, item);
            dirty.insert(table.to_string());
        })
    }

    fn insert(&self, table: &str, item: Value) -> StoreResult<bool> {
        let id = item_id(&item)?;
        self.with(table, |items, dirty| {
            if items.contains_key(&id) {
                return false;
            }
            items.insert(id, item);
            dirty.insert(table.to_string());
            true
        })
    }

    fn put_if(&self, table: &str, item: Value, field: &str, expected: &Value) -> StoreResult<bool> {
        let id = item_id(&item)?;
        self.with(table, |items, dirty| {
            let current = items.get(&id).and_then(|old| old.get(field)).cloned().unwrap_or(Value::Null);
            if current != *expected {
                return false;
            }
            items.insert(id, item);
            dirty.insert(table.to_string());
            true
        })
    }

    fn increment(&self, table: &str, id: &str, field: &str) -> StoreResult<i64> {
        self.with(table, |items, dirty| {
            let item = items.entry(id.to_string()).or_insert_with(|| serde_json::json!({ "id": id }));
            let next = item.get(field).and_then(Value::as_i64).unwrap_or(0) + 1;
            item[field] = Value::from(next);
            dirty.insert(table.to_string());
            next
        })
    }

    fn transact(&self, writes: &[Write]) -> StoreResult<Option<usize>> {
        // Checked first, written after: all or none (the store's lock is held per table,
        // and the app's lock keeps requests apart).
        for (index, write) in writes.iter().enumerate() {
            let id = item_id(&write.item)?;
            if write.new && self.with(write.table, |items, _| items.contains_key(&id))? {
                return Ok(Some(index));
            }
        }
        for write in writes {
            self.put(write.table, write.item.clone())?;
        }
        Ok(None)
    }

    fn delete(&self, table: &str, id: &str) -> StoreResult<bool> {
        self.with(table, |items, dirty| {
            let removed = items.remove(id).is_some();
            if removed {
                dirty.insert(table.to_string());
            }
            removed
        })
    }

    fn query(&self, table: &str, field: &str, value: &str) -> StoreResult<Vec<Value>> {
        self.with(table, |items, _| items.values().filter(|item| item.get(field).and_then(Value::as_str) == Some(value)).cloned().collect())
    }

    fn scan(&self, table: &str) -> StoreResult<Vec<Value>> {
        self.with(table, |items, _| items.values().cloned().collect())
    }

    fn clear(&self) -> StoreResult<()> {
        let mut state = self.state.lock().map_err(|_| StoreError("the store lock is poisoned".into()))?;
        *state = State::default();
        if let Some(dir) = self.directory.as_ref().filter(|d| d.is_dir()) {
            fs::remove_dir_all(dir).map_err(|e| StoreError(format!("{}: {e}", dir.display())))?;
        }
        Ok(())
    }

    fn flush(&self) -> StoreResult<()> {
        let Some(dir) = &self.directory else {
            return Ok(());
        };
        let mut state = self.state.lock().map_err(|_| StoreError("the store lock is poisoned".into()))?;
        let dirty = std::mem::take(&mut state.dirty);
        if dirty.is_empty() {
            return Ok(());
        }
        fs::create_dir_all(dir).map_err(|e| StoreError(format!("{}: {e}", dir.display())))?;
        for table in dirty {
            let items: Vec<&Value> = state.tables.get(&table).map(|t| t.values().collect()).unwrap_or_default();
            let text = serde_json::to_string_pretty(&items).map_err(|e| StoreError(e.to_string()))?;
            let path = dir.join(format!("{table}.json"));
            let tmp = dir.join(format!("{table}.json.{}.tmp", std::process::id()));
            fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, &path)).map_err(|e| StoreError(format!("{}: {e}", path.display())))?;
        }
        Ok(())
    }
}
