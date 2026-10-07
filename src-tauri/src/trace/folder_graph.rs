//! Folder-wide provenance index for the Trace view.
//!
//! The index holds the newest recorded revision of every image directly inside
//! a folder, the folder's unsaved generations, and the direct parents of both,
//! grouped into connected components. It is built from a single SQLite read
//! snapshot with batched queries and existence checks: no image is hashed and
//! no graph is walked per file.
//!
//! Domain assembly (`build_index`) is pure and operates on loaded `Facts`;
//! `load_snapshot` reads SQLite and `resolve_facts` checks the filesystem
//! after the snapshot ends. The built index is cached per token and holds
//! canonical paths; each response re-expresses them under the requested
//! folder spelling and re-checks parents whose presence no token reflects.
use super::*;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) const COMPONENT_PAGE: usize = 200;
pub(crate) const MEMBER_PAGE: usize = 1000;
pub(crate) const NODE_PAGE: usize = 1000;
pub(crate) const MAX_RUN_DETAILS: usize = 64;
/// Pages also stop at this serialized size so that a page of long paths or
/// prompts stays well under the 1 MiB protocol frame. Callers continue from
/// `offset + items.len()` until `total` is reached; nothing is truncated.
const PAGE_BYTE_BUDGET: usize = 512 * 1024;
const MAX_PROMPT_CHARS: usize = 280;
const SQL_BATCH: usize = 500;
const CACHE_CAPACITY: usize = 8;
const PLACEHOLDER_ORDER: i64 = 1_000_000_000_000;
const MAX_TOKEN_CHARS: usize = 128;
const MAX_COMPONENT_ID_CHARS: usize = 64;
/// Windows and default macOS volumes compare paths case-insensitively;
/// recorded paths keep their case. A case-sensitive macOS volume is treated
/// as insensitive too, which can only merge spellings that differ in case.
const CASE_INSENSITIVE_PATHS: bool = cfg!(any(windows, target_os = "macos"));
const TEMPORARY_LOCATION: &str = "Temporary · not yet saved";
const PLACEHOLDER_LOCATION: &str = "Generating…";

// ---------------------------------------------------------------------------
// Change counter: every provenance mutation, from any writer, bumps one row.
// ---------------------------------------------------------------------------

/// Tables whose contents shape a folder index, and the events that change them.
const COUNTED_TABLES: [(&str, &[&str]); 6] = [
    ("artifacts", &["INSERT", "UPDATE", "DELETE"]),
    // Only status and parameters (temporary storage, prompt) affect the index.
    ("runs", &["INSERT", "UPDATE OF status,parameters", "DELETE"]),
    ("run_inputs", &["INSERT", "UPDATE", "DELETE"]),
    ("artifact_locators", &["INSERT", "UPDATE", "DELETE"]),
    ("image_discards", &["INSERT", "UPDATE", "DELETE"]),
    ("image_folder_contexts", &["INSERT", "UPDATE", "DELETE"]),
];

fn counter_triggers() -> Vec<(String, String)> {
    COUNTED_TABLES
        .iter()
        .flat_map(|(table, events)| {
            events.iter().map(move |event| {
                let suffix = event
                    .split_whitespace()
                    .next()
                    .expect("trigger event")
                    .to_ascii_lowercase();
                let name = format!("trace_revision_{table}_{suffix}");
                let statement = format!(
                    "CREATE TRIGGER IF NOT EXISTS {name} AFTER {event} ON {table} BEGIN UPDATE trace_revision SET value=value+1 WHERE id=1; END;"
                );
                (name, statement)
            })
        })
        .collect()
}

/// Installs the change counter that folder index tokens are derived from.
/// Additive and idempotent: older builds ignore the table and keep firing the
/// triggers, so `user_version` is unchanged. Checked read-only first so an
/// ordinary connection never takes a write lock.
pub(super) fn ensure_change_counter(connection: &Connection) -> Result<(), AppError> {
    let triggers = counter_triggers();
    let names: Vec<&str> = triggers.iter().map(|(name, _)| name.as_str()).collect();
    let installed: i64 = batched(
        connection,
        "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ({})",
        &names,
        |row| row.get::<_, i64>(0),
    )?
    .into_iter()
    .sum();
    let has_table: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='trace_revision')",
            [],
            |row| row.get(0),
        )
        .map_err(sql)?;
    let has_row = has_table
        && connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM trace_revision WHERE id=1)",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(sql)?;
    if has_row && installed == names.len() as i64 {
        return Ok(());
    }
    let mut batch = String::from(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS trace_revision (id INTEGER PRIMARY KEY CHECK (id=1), value INTEGER NOT NULL);
         INSERT OR IGNORE INTO trace_revision(id,value) VALUES (1,0);",
    );
    for (_, statement) in &triggers {
        batch.push_str(statement);
    }
    batch.push_str("COMMIT;");
    connection.execute_batch(&batch).map_err(sql)
}

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NodeScope {
    Current,
    Subfolder,
    External,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NodeState {
    Present,
    Missing,
    Unavailable,
    Running,
    Uncertain,
}

impl From<ArtifactPathState> for NodeState {
    fn from(state: ArtifactPathState) -> Self {
        match state {
            ArtifactPathState::Present => Self::Present,
            ArtifactPathState::Missing => Self::Missing,
            ArtifactPathState::Unavailable => Self::Unavailable,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceNode {
    pub key: String,
    pub artifact_id: Option<i64>,
    pub run_id: Option<i64>,
    pub parents: Vec<String>,
    pub path: Option<String>,
    pub scope: NodeScope,
    pub location: String,
    pub state: NodeState,
    pub temporary: bool,
    pub discarded: bool,
    pub earlier_revision: bool,
    pub order: i64,
    pub prompt: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Cover {
    pub path: String,
    pub present: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComponentSummary {
    pub id: String,
    pub title: String,
    pub cover: Option<Cover>,
    pub image_count: usize,
    pub node_count: usize,
    pub active: bool,
    pub unsaved: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Member {
    pub path: String,
    pub component_id: String,
    pub key: String,
}

#[derive(Default)]
struct FolderIndex {
    components: Vec<ComponentSummary>,
    nodes: HashMap<String, Vec<TraceNode>>,
    members: Vec<Member>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComponentsPage {
    token: String,
    total: usize,
    offset: usize,
    components: Vec<ComponentSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MembersPage {
    stale: bool,
    total: usize,
    offset: usize,
    members: Vec<Member>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodesPage {
    stale: bool,
    total: usize,
    offset: usize,
    nodes: Vec<TraceNode>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RevisionStatus {
    Matched,
    Changed,
    Unverified,
    Missing,
}

/// A recorded revision as loaded for one index build.
#[derive(Clone, Debug)]
struct ArtifactFacts {
    /// Recorded path in native, simplified form.
    path: String,
    generating_run: Option<i64>,
    state: NodeState,
    discarded: bool,
    earlier_revision: bool,
    /// Position among all outputs of `generating_run`, ordered by ID.
    output_index: usize,
}

#[derive(Clone, Debug)]
struct RunFacts {
    status: String,
    temporary: bool,
    prompt: String,
    /// Input artifact IDs in position order, possibly repeated.
    inputs: Vec<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Seed {
    /// `direct`: the recorded file is directly inside the folder. Otherwise it
    /// is an unsaved output of a generation meant for this folder.
    Artifact { id: i64, direct: bool },
    /// A running or uncertain folder generation that has no output yet.
    Placeholder { run: i64 },
}

#[derive(Default, Debug)]
struct Facts {
    seeds: Vec<Seed>,
    artifacts: HashMap<i64, ArtifactFacts>,
    runs: HashMap<i64, RunFacts>,
}

struct Layout<'a> {
    folder: &'a Path,
    home: Option<&'a Path>,
    case_insensitive: bool,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn same_component(left: &std::ffi::OsStr, right: &std::ffi::OsStr, case_insensitive: bool) -> bool {
    if case_insensitive {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

/// `path` relative to `base` when `base` is one of its ancestors (or itself).
fn relative_within(path: &Path, base: &Path, case_insensitive: bool) -> Option<PathBuf> {
    let mut remaining = path.components();
    for expected in base.components() {
        let actual = remaining.next()?;
        if !same_component(actual.as_os_str(), expected.as_os_str(), case_insensitive) {
            return None;
        }
    }
    Some(remaining.as_path().to_path_buf())
}

fn classify(path: &Path, folder: &Path, case_insensitive: bool) -> (NodeScope, Option<PathBuf>) {
    match relative_within(path, folder, case_insensitive) {
        Some(relative) => match relative.components().count() {
            0 => (NodeScope::External, None),
            1 => (NodeScope::Current, Some(relative)),
            _ => (NodeScope::Subfolder, Some(relative)),
        },
        None => (NodeScope::External, None),
    }
}

fn external_location(path: &Path, home: Option<&Path>, case_insensitive: bool) -> String {
    match home.and_then(|home| relative_within(path, home, case_insensitive)) {
        Some(relative) if relative.as_os_str().is_empty() => "~".to_owned(),
        Some(relative) => format!(
            "~{}{}",
            std::path::MAIN_SEPARATOR,
            relative.to_string_lossy()
        ),
        None => path.to_string_lossy().into_owned(),
    }
}

fn location(path: &Path, scope: NodeScope, relative: Option<&Path>, layout: &Layout) -> String {
    match (scope, relative) {
        (NodeScope::Current, _) => format!(
            "./{}",
            path.file_name().unwrap_or_default().to_string_lossy()
        ),
        (NodeScope::Subfolder, Some(relative)) => relative.to_string_lossy().into_owned(),
        _ => external_location(path, layout.home, layout.case_insensitive),
    }
}

/// Identity of a recorded path as the filesystem compares it.
fn path_identity(path: &str, case_insensitive: bool) -> String {
    let path = simplified(path);
    if case_insensitive {
        path.to_lowercase()
    } else {
        path
    }
}

/// The newest revision ID recorded at each path, by path identity.
fn newest_by_path<'a>(
    revisions: impl IntoIterator<Item = (i64, &'a str)>,
    case_insensitive: bool,
) -> HashMap<String, i64> {
    let mut newest: HashMap<String, i64> = HashMap::new();
    for (id, path) in revisions {
        let entry = newest
            .entry(path_identity(path, case_insensitive))
            .or_insert(id);
        *entry = (*entry).max(id);
    }
    newest
}

/// `path` as the client knows it: a path inside the canonical `folder` tree
/// is re-expressed under the `requested` spelling of that folder (a symlink,
/// junction, mapped drive or differently cased path), so it matches the
/// Explorer entries listed from `requested`. Other paths stay as recorded.
fn as_requested(path: &str, folder: &Path, requested: &Path, case_insensitive: bool) -> String {
    match relative_within(Path::new(path), folder, case_insensitive) {
        Some(relative) if !relative.as_os_str().is_empty() => {
            requested.join(relative).to_string_lossy().into_owned()
        }
        _ => path.to_owned(),
    }
}

fn truncate_prompt(prompt: &str) -> String {
    prompt.chars().take(MAX_PROMPT_CHARS).collect()
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_owned())
}

/// Disjoint sets with path halving; roots are the smallest index in a set.
struct UnionFind(Vec<usize>);

impl UnionFind {
    fn new(size: usize) -> Self {
        Self((0..size).collect())
    }
    fn find(&mut self, mut node: usize) -> usize {
        while self.0[node] != node {
            self.0[node] = self.0[self.0[node]];
            node = self.0[node];
        }
        node
    }
    fn union(&mut self, left: usize, right: usize) {
        let (left, right) = (self.find(left), self.find(right));
        if left != right {
            self.0[left.max(right)] = left.min(right);
        }
    }
}

/// What a node key names. Keys survive completion, saving and moving: a
/// placeholder and the first output of its run share `Output { index: 0 }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum NodeIdentity {
    /// A recorded image that no run generated.
    Source(i64),
    /// Output `index` of generation `run`.
    Output { run: i64, index: usize },
}

impl NodeIdentity {
    fn key(&self) -> String {
        match self {
            Self::Source(id) => format!("a:{id}"),
            Self::Output { run, index } => format!("o:{run}:{index}"),
        }
    }
}

/// Names a component after its oldest node identity: sources before outputs,
/// then by ID. Because keys are stable, the ID survives completion, saving,
/// moving, and new descendants (whose runs are newer). It changes only when
/// the component merges with another, or loses that node.
fn component_id(identities: impl Iterator<Item = NodeIdentity>) -> String {
    identities
        .min()
        .map(|identity| format!("c:{}", identity.key()))
        .unwrap_or_default()
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
enum NodeRef {
    Artifact(i64),
    Placeholder(i64),
}

/// Assembles the displayed graph: seeds and their direct parents, edges among
/// them, connected components, summaries and folder members.
fn build_index(facts: &Facts, layout: &Layout) -> FolderIndex {
    let run_of = |node: NodeRef| match node {
        NodeRef::Artifact(id) => facts.artifacts.get(&id).and_then(|a| a.generating_run),
        NodeRef::Placeholder(run) => Some(run),
    };
    let inputs_of = |node: NodeRef| {
        run_of(node)
            .and_then(|run| facts.runs.get(&run))
            .map(|run| run.inputs.as_slice())
            .unwrap_or_default()
    };

    // Displayed nodes: seeds, then the direct parents of each seed.
    let mut displayed: Vec<NodeRef> = Vec::new();
    let mut position: HashMap<NodeRef, usize> = HashMap::new();
    let mut display = |node: NodeRef| {
        position.entry(node).or_insert_with(|| {
            displayed.push(node);
            displayed.len() - 1
        });
    };
    let mut direct = HashSet::new();
    let mut context_outputs = HashSet::new();
    for seed in &facts.seeds {
        let node = match *seed {
            Seed::Artifact {
                id,
                direct: is_direct,
            } => {
                if !facts.artifacts.contains_key(&id) {
                    continue;
                }
                if is_direct {
                    direct.insert(id);
                } else {
                    context_outputs.insert(id);
                }
                NodeRef::Artifact(id)
            }
            Seed::Placeholder { run } => NodeRef::Placeholder(run),
        };
        display(node);
        for input in inputs_of(node) {
            if facts.artifacts.contains_key(input) {
                display(NodeRef::Artifact(*input));
            }
        }
    }

    // Edges among displayed nodes, deduplicated in input position order.
    let parents: Vec<Vec<usize>> = displayed
        .iter()
        .map(|node| {
            let mut parents: Vec<usize> = Vec::new();
            for input in inputs_of(*node) {
                if let Some(&parent) = position.get(&NodeRef::Artifact(*input)) {
                    if !parents.contains(&parent) {
                        parents.push(parent);
                    }
                }
            }
            parents
        })
        .collect();

    let identities: Vec<NodeIdentity> = displayed
        .iter()
        .map(|node| match *node {
            NodeRef::Artifact(id) => {
                let artifact = &facts.artifacts[&id];
                match artifact.generating_run {
                    Some(run) => NodeIdentity::Output {
                        run,
                        index: artifact.output_index,
                    },
                    None => NodeIdentity::Source(id),
                }
            }
            // The first completed output of this run takes over this key.
            NodeRef::Placeholder(run) => NodeIdentity::Output { run, index: 0 },
        })
        .collect();
    let keys: Vec<String> = identities.iter().map(NodeIdentity::key).collect();

    let nodes: Vec<TraceNode> = displayed
        .iter()
        .enumerate()
        .map(|(index, node)| {
            let key = keys[index].clone();
            let parents = parents[index].iter().map(|p| keys[*p].clone()).collect();
            match *node {
                NodeRef::Artifact(id) => {
                    let artifact = &facts.artifacts[&id];
                    let run = artifact.generating_run.and_then(|run| facts.runs.get(&run));
                    let temporary = run.is_some_and(|run| run.temporary);
                    let path = Path::new(&artifact.path);
                    // Unsaved outputs live in managed storage but belong here.
                    let (scope, relative) = if context_outputs.contains(&id) {
                        (NodeScope::Current, None)
                    } else {
                        classify(path, layout.folder, layout.case_insensitive)
                    };
                    TraceNode {
                        key,
                        artifact_id: Some(id),
                        run_id: artifact.generating_run,
                        parents,
                        path: Some(artifact.path.clone()),
                        scope,
                        location: if temporary {
                            TEMPORARY_LOCATION.to_owned()
                        } else {
                            location(path, scope, relative.as_deref(), layout)
                        },
                        state: artifact.state,
                        temporary,
                        discarded: artifact.discarded,
                        earlier_revision: artifact.earlier_revision,
                        order: id,
                        prompt: run.map(|run| run.prompt.clone()).unwrap_or_default(),
                    }
                }
                NodeRef::Placeholder(run_id) => {
                    let run = facts.runs.get(&run_id);
                    TraceNode {
                        key,
                        artifact_id: None,
                        run_id: Some(run_id),
                        parents,
                        path: None,
                        scope: NodeScope::Current,
                        location: PLACEHOLDER_LOCATION.to_owned(),
                        state: match run.map(|run| run.status.as_str()) {
                            Some("uncertain") => NodeState::Uncertain,
                            _ => NodeState::Running,
                        },
                        temporary: run.is_some_and(|run| run.temporary),
                        discarded: false,
                        earlier_revision: false,
                        order: PLACEHOLDER_ORDER + run_id,
                        prompt: run.map(|run| run.prompt.clone()).unwrap_or_default(),
                    }
                }
            }
        })
        .collect();

    let mut sets = UnionFind::new(nodes.len());
    for (child, parents) in parents.iter().enumerate() {
        for parent in parents {
            sets.union(child, *parent);
        }
    }
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for index in 0..nodes.len() {
        groups.entry(sets.find(index)).or_default().push(index);
    }

    let mut component_of = vec![String::new(); nodes.len()];
    let mut ranked: Vec<(i64, ComponentSummary, Vec<TraceNode>)> = groups
        .into_values()
        .map(|members| {
            let id = component_id(members.iter().map(|index| identities[*index]));
            for index in &members {
                component_of[*index] = id.clone();
            }
            let summary = summarize(&id, &members, &nodes, &parents, facts);
            let newest = members
                .iter()
                .map(|index| nodes[*index].order)
                .max()
                .unwrap_or_default();
            let mut component_nodes: Vec<TraceNode> =
                members.iter().map(|index| nodes[*index].clone()).collect();
            component_nodes.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.key.cmp(&b.key)));
            (newest, summary, component_nodes)
        })
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));

    let mut members: Vec<Member> = displayed
        .iter()
        .enumerate()
        .filter(|(_, node)| matches!(node, NodeRef::Artifact(id) if direct.contains(id)))
        .filter(|(index, _)| nodes[*index].state == NodeState::Present)
        .map(|(index, _)| Member {
            path: nodes[index].path.clone().unwrap_or_default(),
            component_id: component_of[index].clone(),
            key: nodes[index].key.clone(),
        })
        .collect();
    members.sort_by(|a, b| a.path.cmp(&b.path));

    let mut index = FolderIndex::default();
    for (_, summary, component_nodes) in ranked {
        index.nodes.insert(summary.id.clone(), component_nodes);
        index.components.push(summary);
    }
    index.members = members;
    index
}

fn summarize(
    id: &str,
    members: &[usize],
    nodes: &[TraceNode],
    parents: &[Vec<usize>],
    facts: &Facts,
) -> ComponentSummary {
    let is_current = |index: usize| nodes[index].scope == NodeScope::Current;
    let oldest_with_path = |candidates: &mut dyn Iterator<Item = usize>| {
        candidates
            .filter(|index| nodes[*index].path.is_some())
            .min_by_key(|index| nodes[*index].order)
    };
    let title_node = oldest_with_path(&mut members.iter().copied().filter(|index| {
        is_current(*index) && !parents[*index].iter().any(|parent| is_current(*parent))
    }))
    .or_else(|| oldest_with_path(&mut members.iter().copied()));
    let (title, cover) = match title_node {
        Some(index) => {
            let path = nodes[index].path.clone().unwrap_or_default();
            (
                file_stem(&path),
                Some(Cover {
                    path,
                    present: nodes[index].state == NodeState::Present,
                }),
            )
        }
        None => ("Generating".to_owned(), None),
    };
    ComponentSummary {
        id: id.to_owned(),
        title,
        cover,
        // An earlier revision shares its file with the newest one.
        image_count: members
            .iter()
            .map(|index| &nodes[*index])
            .filter(|node| {
                node.scope == NodeScope::Current
                    && node.state == NodeState::Present
                    && !node.earlier_revision
            })
            .count(),
        node_count: members.len(),
        active: members.iter().any(|index| {
            let node = &nodes[*index];
            matches!(node.state, NodeState::Running | NodeState::Uncertain)
                || node
                    .run_id
                    .and_then(|run| facts.runs.get(&run))
                    .is_some_and(|run| run.status == "running")
        }),
        unsaved: members.iter().any(|index| nodes[*index].temporary),
    }
}

fn page<T: Serialize + Clone>(items: &[T], offset: usize, limit: usize) -> Vec<T> {
    let mut bytes = 0;
    let mut page = Vec::new();
    for item in items.iter().skip(offset).take(limit) {
        bytes += serde_json::to_vec(item).map(|v| v.len() + 1).unwrap_or(0);
        if !page.is_empty() && bytes > PAGE_BYTE_BUDGET {
            break;
        }
        page.push(item.clone());
    }
    page
}

/// Names one state of a folder's index. `unsaved` describes the presence of
/// the folder's unsaved outputs, which live outside the folder so its mtime
/// cannot reflect them.
fn snapshot_token(
    database: &Path,
    folder: &str,
    modified: Option<SystemTime>,
    revision: u64,
    counter: Option<i64>,
    unsaved: &str,
) -> String {
    let modified = modified
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_nanos().to_string())
        .unwrap_or_else(|| "-".into());
    let counter = counter.map_or_else(|| "-".into(), |value| value.to_string());
    let mut hasher = Sha256::new();
    for part in [
        database.to_string_lossy().as_ref(),
        folder,
        &modified,
        &revision.to_string(),
        &counter,
        unsaved,
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hex::encode(&hasher.finalize()[..16])
}

// ---------------------------------------------------------------------------
// Infrastructure: SQLite snapshot and filesystem checks
// ---------------------------------------------------------------------------

/// Runs `query` (with `{}` standing for the bound list) over `values` in
/// bounded chunks and collects every row.
fn batched<P: rusqlite::ToSql, T>(
    connection: &Connection,
    query: &str,
    values: &[P],
    mut read: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, AppError> {
    let mut rows = Vec::new();
    for chunk in values.chunks(SQL_BATCH) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let mut statement = connection
            .prepare(&query.replace("{}", &placeholders))
            .map_err(sql)?;
        let mapped = statement
            .query_map(rusqlite::params_from_iter(chunk.iter()), &mut read)
            .map_err(sql)?;
        for row in mapped {
            rows.push(row.map_err(sql)?);
        }
    }
    Ok(rows)
}

struct ArtifactRow {
    /// As recorded, for exact-path SQL lookups.
    recorded: String,
    generating_run: Option<i64>,
}

fn simplified(path: &str) -> String {
    dunce::simplified(Path::new(path))
        .to_string_lossy()
        .into_owned()
}

fn read_artifact_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(i64, ArtifactRow)> {
    Ok((
        row.get(0)?,
        ArtifactRow {
            recorded: row.get(1)?,
            generating_run: row.get(2)?,
        },
    ))
}

fn load_artifact_rows(
    connection: &Connection,
    ids: &[i64],
    rows: &mut HashMap<i64, ArtifactRow>,
) -> Result<(), AppError> {
    let missing: Vec<i64> = ids
        .iter()
        .copied()
        .filter(|id| !rows.contains_key(id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    for (id, row) in batched(
        connection,
        "SELECT id,path,generating_run FROM artifacts WHERE id IN ({})",
        &missing,
        read_artifact_row,
    )? {
        rows.insert(id, row);
    }
    Ok(())
}

fn discarded_among(connection: &Connection, ids: &[i64]) -> Result<HashSet<i64>, AppError> {
    Ok(batched(
        connection,
        "SELECT artifact_id FROM image_discards WHERE completed=1 AND artifact_id IN ({})",
        ids,
        |row| row.get(0),
    )?
    .into_iter()
    .collect())
}

/// The given revisions at whose path a newer revision exists. `known` holds
/// the newest revision per path identity among rows already loaded (every
/// revision directly inside the folder), which also catches differently
/// cased spellings there; elsewhere the exact recorded path is looked up.
fn superseded_among(
    connection: &Connection,
    ids: &[i64],
    rows: &HashMap<i64, ArtifactRow>,
    known: &HashMap<String, i64>,
    case_insensitive: bool,
) -> Result<HashSet<i64>, AppError> {
    let paths: Vec<&str> = ids
        .iter()
        .map(|id| rows[id].recorded.as_str())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let recorded: Vec<(i64, String)> = batched(
        connection,
        "SELECT MAX(id),path FROM artifacts WHERE path IN ({}) GROUP BY path",
        &paths,
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut newest = newest_by_path(
        recorded.iter().map(|(id, path)| (*id, path.as_str())),
        case_insensitive,
    );
    for (path, id) in known {
        let entry = newest.entry(path.clone()).or_insert(*id);
        *entry = (*entry).max(*id);
    }
    Ok(ids
        .iter()
        .copied()
        .filter(|id| {
            newest
                .get(&path_identity(&rows[id].recorded, case_insensitive))
                .is_some_and(|newest| newest > id)
        })
        .collect())
}

fn inputs_of(
    connection: &Connection,
    runs: &[i64],
    inputs: &mut HashMap<i64, Vec<i64>>,
) -> Result<(), AppError> {
    let missing: Vec<i64> = runs
        .iter()
        .copied()
        .filter(|run| !inputs.contains_key(run))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    for run in &missing {
        inputs.insert(*run, Vec::new());
    }
    for (run, artifact) in batched(
        connection,
        "SELECT run_id,artifact_id FROM run_inputs WHERE run_id IN ({}) ORDER BY run_id,position",
        &missing,
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )? {
        inputs.entry(run).or_default().push(artifact);
    }
    Ok(())
}

fn load_snapshot(
    connection: &Connection,
    folder: &str,
    layout: &Layout,
) -> Result<Loaded, AppError> {
    let mut rows: HashMap<i64, ArtifactRow> = HashMap::new();

    // (a) Revisions recorded, or aliased, directly inside the folder. Earlier
    // revisions at a path are superseded by the newest one recorded there.
    let separator = std::path::MAIN_SEPARATOR;
    let prefix = if folder.ends_with(separator) {
        folder.to_owned()
    } else {
        format!("{folder}{separator}")
    };
    let mut upper = prefix.clone();
    upper.pop();
    upper.push(char::from_u32(separator as u32 + 1).expect("ASCII path separator"));
    let mut statement = connection
        .prepare(
            "SELECT a.id,a.path,a.generating_run FROM artifacts a WHERE a.path>=?1 AND a.path<?2 AND instr(substr(a.path,?3),?4)=0
             UNION SELECT a.id,a.path,a.generating_run FROM artifact_locators l JOIN artifacts a ON a.id=l.artifact_id
             WHERE l.path>=?1 AND l.path<?2 AND instr(substr(l.path,?3),?4)=0",
        )
        .map_err(sql)?;
    let found = statement
        .query_map(
            params![
                prefix,
                upper,
                prefix.chars().count() as i64 + 1,
                separator.to_string()
            ],
            read_artifact_row,
        )
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    drop(statement);
    // Paths compare as the filesystem does, so a case-only rename on a
    // case-insensitive volume leaves one member rather than two.
    let known = newest_by_path(
        found.iter().map(|(id, row)| (*id, row.recorded.as_str())),
        layout.case_insensitive,
    );
    let direct = newest_by_path(
        found
            .iter()
            .filter(|(_, row)| {
                classify(
                    Path::new(&simplified(&row.recorded)),
                    layout.folder,
                    layout.case_insensitive,
                )
                .0 == NodeScope::Current
            })
            .map(|(id, row)| (*id, row.recorded.as_str())),
        layout.case_insensitive,
    );
    rows.extend(found);
    let mut candidates: Vec<(i64, bool)> = direct.into_values().map(|id| (id, true)).collect();

    // (b) Unsaved generations meant for this folder, and their outputs.
    let mut statement = connection
        .prepare(
            "SELECT r.id,r.status FROM image_folder_contexts c JOIN runs r ON r.id=c.run_id
             WHERE c.folder=?1 AND r.status IN ('running','uncertain','interrupted','succeeded')",
        )
        .map_err(sql)?;
    let contexts = statement
        .query_map([folder], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    drop(statement);
    let context_runs: Vec<i64> = contexts.iter().map(|(run, _)| *run).collect();
    let mut with_output = HashSet::new();
    let direct_candidates: HashSet<i64> = candidates.iter().map(|(id, _)| *id).collect();
    for (id, row) in batched(
        connection,
        "SELECT id,path,generating_run FROM artifacts WHERE generating_run IN ({})",
        &context_runs,
        read_artifact_row,
    )? {
        with_output.extend(row.generating_run);
        if !direct_candidates.contains(&id) {
            candidates.push((id, false));
        }
        rows.insert(id, row);
    }
    let placeholders: Vec<i64> = contexts
        .iter()
        .filter(|(run, status)| {
            !with_output.contains(run) && matches!(status.as_str(), "running" | "uncertain")
        })
        .map(|(run, _)| *run)
        .collect();

    // Only the newest, non-discarded revisions can be seeds. Presence is
    // checked after the snapshot ends (see `resolve_facts`).
    let candidate_ids: Vec<i64> = candidates.iter().map(|(id, _)| *id).collect();
    let mut discarded = discarded_among(connection, &candidate_ids)?;
    let mut superseded = superseded_among(
        connection,
        &candidate_ids,
        &rows,
        &known,
        layout.case_insensitive,
    )?;
    candidates.retain(|(id, _)| !discarded.contains(id) && !superseded.contains(id));

    // Direct parents of every candidate: the inputs of its generating run.
    let mut inputs: HashMap<i64, Vec<i64>> = HashMap::new();
    let candidate_runs: Vec<i64> = candidates
        .iter()
        .filter_map(|(id, _)| rows[id].generating_run)
        .chain(placeholders.iter().copied())
        .collect();
    inputs_of(connection, &candidate_runs, &mut inputs)?;
    let checked: HashSet<i64> = candidate_ids.iter().copied().collect();
    let parents: Vec<i64> = candidate_runs
        .iter()
        .flat_map(|run| inputs[run].iter().copied())
        .filter(|id| !checked.contains(id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    load_artifact_rows(connection, &parents, &mut rows)?;
    let parents: Vec<i64> = parents
        .into_iter()
        .filter(|id| rows.contains_key(id))
        .collect();
    discarded.extend(discarded_among(connection, &parents)?);
    superseded.extend(superseded_among(
        connection,
        &parents,
        &rows,
        &known,
        layout.case_insensitive,
    )?);

    // Runs of every node that may be displayed: inputs for edges, status,
    // prompt, and the output order that keys are derived from.
    let mut runs: Vec<i64> = rows
        .values()
        .filter_map(|row| row.generating_run)
        .chain(placeholders.iter().copied())
        .collect();
    runs.sort_unstable();
    runs.dedup();
    inputs_of(connection, &runs, &mut inputs)?;
    let mut run_facts: HashMap<i64, RunFacts> = HashMap::new();
    for (id, status, parameters) in batched(
        connection,
        "SELECT id,status,parameters FROM runs WHERE id IN ({})",
        &runs,
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    )? {
        let parameters: serde_json::Value = serde_json::from_str(&parameters).unwrap_or_default();
        run_facts.insert(
            id,
            RunFacts {
                status,
                temporary: parameters
                    .get("output_storage")
                    .and_then(serde_json::Value::as_str)
                    == Some("temporary"),
                prompt: parameters
                    .get("prompt")
                    .and_then(serde_json::Value::as_str)
                    .map(truncate_prompt)
                    .unwrap_or_default(),
                inputs: inputs.remove(&id).unwrap_or_default(),
            },
        );
    }
    let mut output_index: HashMap<i64, usize> = HashMap::new();
    let mut previous: Option<(i64, usize)> = None;
    for (id, run) in batched(
        connection,
        "SELECT id,generating_run FROM artifacts WHERE generating_run IN ({}) ORDER BY generating_run,id",
        &runs,
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )? {
        let index = match previous {
            Some((last, index)) if last == run => index + 1,
            _ => 0,
        };
        previous = Some((run, index));
        output_index.insert(id, index);
    }
    Ok(Loaded {
        candidates,
        placeholders,
        rows,
        runs: run_facts,
        discarded,
        superseded,
        output_index,
    })
}

/// Provenance read from one snapshot, before any filesystem check.
struct Loaded {
    /// Newest, non-discarded revisions that are seeds if their file is present.
    candidates: Vec<(i64, bool)>,
    placeholders: Vec<i64>,
    rows: HashMap<i64, ArtifactRow>,
    runs: HashMap<i64, RunFacts>,
    discarded: HashSet<i64>,
    superseded: HashSet<i64>,
    output_index: HashMap<i64, usize>,
}

/// Applies existence checks, outside the SQLite snapshot so a slow volume
/// never holds a read lock that writers wait on.
fn resolve_facts(loaded: Loaded) -> Facts {
    let Loaded {
        candidates,
        placeholders,
        rows,
        runs,
        discarded,
        superseded,
        output_index,
    } = loaded;
    let state_of =
        |id: i64| -> NodeState { artifact_path_state(Path::new(&rows[&id].recorded)).into() };
    let mut states: HashMap<i64, NodeState> = HashMap::new();
    let mut seeds: Vec<Seed> = Vec::new();
    for (id, direct) in candidates {
        let state = state_of(id);
        states.insert(id, state);
        if state == NodeState::Present {
            seeds.push(Seed::Artifact { id, direct });
        }
    }
    seeds.extend(
        placeholders
            .into_iter()
            .map(|run| Seed::Placeholder { run }),
    );
    let mut displayed: Vec<i64> = Vec::new();
    for seed in &seeds {
        let run = match seed {
            Seed::Artifact { id, .. } => {
                displayed.push(*id);
                rows[id].generating_run
            }
            Seed::Placeholder { run } => Some(*run),
        };
        let inputs = run
            .and_then(|run| runs.get(&run))
            .map(|run| run.inputs.as_slice());
        displayed.extend(
            inputs
                .unwrap_or_default()
                .iter()
                .filter(|id| rows.contains_key(id)),
        );
    }
    displayed.sort_unstable();
    displayed.dedup();
    let artifacts = displayed
        .into_iter()
        .map(|id| {
            let row = &rows[&id];
            let state = *states.entry(id).or_insert_with(|| state_of(id));
            (
                id,
                ArtifactFacts {
                    path: simplified(&row.recorded),
                    generating_run: row.generating_run,
                    state,
                    discarded: discarded.contains(&id),
                    earlier_revision: superseded.contains(&id),
                    output_index: output_index.get(&id).copied().unwrap_or_default(),
                },
            )
        })
        .collect();
    Facts {
        seeds,
        artifacts,
        runs,
    }
}

// ---------------------------------------------------------------------------
// Index cache and queries
// ---------------------------------------------------------------------------

static INDEXES: Mutex<Vec<(String, Arc<FolderIndex>)>> = Mutex::new(Vec::new());

fn cached(token: &str) -> Result<Option<Arc<FolderIndex>>, AppError> {
    let mut cache = INDEXES
        .lock()
        .map_err(|_| AppError::Other("Trace folder index cache unavailable".into()))?;
    let found = cache.iter().position(|(key, _)| key == token);
    Ok(found.map(|position| {
        let entry = cache.remove(position);
        let index = entry.1.clone();
        cache.insert(0, entry);
        index
    }))
}

fn remember(token: String, index: Arc<FolderIndex>) -> Result<(), AppError> {
    let mut cache = INDEXES
        .lock()
        .map_err(|_| AppError::Other("Trace folder index cache unavailable".into()))?;
    cache.retain(|(key, _)| key != &token);
    cache.insert(0, (token, index));
    cache.truncate(CACHE_CAPACITY);
    Ok(())
}

fn canonical_home() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let home = fs::canonicalize(&home).unwrap_or(home);
    Some(dunce::simplified(&home).to_path_buf())
}

/// The provenance part of a token: the change counter, and the folder's
/// unsaved outputs, whose presence the folder mtime cannot reflect.
struct Head {
    counter: i64,
    unsaved: Vec<(i64, String)>,
}

fn read_head(connection: &Connection, folder: &str) -> Result<Head, AppError> {
    let counter: i64 = connection
        .query_row("SELECT value FROM trace_revision WHERE id=1", [], |row| {
            row.get(0)
        })
        .map_err(sql)?;
    let mut statement = connection
        .prepare(
            "SELECT a.id,a.path FROM image_folder_contexts c JOIN artifacts a ON a.generating_run=c.run_id
             WHERE c.folder=?1 ORDER BY a.id",
        )
        .map_err(sql)?;
    let unsaved = statement
        .query_map([folder], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    Ok(Head { counter, unsaved })
}

/// Presence of every unsaved output, by ID. A filesystem check, so it runs
/// outside any SQLite snapshot.
fn unsaved_presence(unsaved: &[(i64, String)]) -> String {
    unsaved
        .iter()
        .map(|(id, path)| format!("{id}:{},", u8::from(Path::new(path).is_file())))
        .collect()
}

/// A folder's index, the token naming it, and the canonical folder it
/// describes.
struct Current {
    token: String,
    index: Arc<FolderIndex>,
    folder: PathBuf,
}

/// The index for the folder's current state, built once per token. The
/// token's counter is read inside the same snapshot as the index, so an index
/// can never be newer or older than the provenance its token names. No
/// filesystem check runs while a snapshot is open: a slow volume must never
/// hold a read transaction that writers and checkpoints wait on.
fn current_index(database: &Path, directory: &Path) -> Result<Current, AppError> {
    let folder = folders::key(directory)?;
    let modified = fs::metadata(&folder)?.modified().ok();
    let revision = folders::revision();
    let token_of = |head: Option<&Head>| {
        snapshot_token(
            database,
            &folder,
            modified,
            revision,
            head.map(|head| head.counter),
            &head.map_or_else(String::new, |head| unsaved_presence(&head.unsaved)),
        )
    };
    if !database.exists() {
        return Ok(Current {
            token: token_of(None),
            index: Arc::new(FolderIndex::default()),
            folder: PathBuf::from(folder),
        });
    }
    let connection = connection_at(database)?;
    let head = {
        let snapshot = connection.unchecked_transaction().map_err(sql)?;
        read_head(&snapshot, &folder)?
    };
    let token = token_of(Some(&head));
    if let Some(index) = cached(&token)? {
        return Ok(Current {
            token,
            index,
            folder: PathBuf::from(folder),
        });
    }
    let home = canonical_home();
    let layout = Layout {
        folder: Path::new(&folder),
        home: home.as_deref(),
        case_insensitive: CASE_INSENSITIVE_PATHS,
    };
    let snapshot = connection.unchecked_transaction().map_err(sql)?;
    let built_from = read_head(&snapshot, &folder)?;
    let loaded = load_snapshot(&snapshot, &folder, &layout)?;
    drop(snapshot);
    // A write between the two snapshots: name the provenance actually loaded.
    let token = if built_from.counter == head.counter {
        token
    } else {
        token_of(Some(&built_from))
    };
    let facts = resolve_facts(loaded);
    let index = Arc::new(build_index(&facts, &layout));
    remember(token.clone(), index.clone())?;
    Ok(Current {
        token,
        index,
        folder: PathBuf::from(folder),
    })
}

/// How index entries are presented for one request: paths inside the folder
/// tree under the requested spelling of the folder.
struct Presentation<'a> {
    folder: &'a Path,
    requested: &'a Path,
}

impl Presentation<'_> {
    fn path(&self, path: &str) -> String {
        as_requested(path, self.folder, self.requested, CASE_INSENSITIVE_PATHS)
    }

    fn member(&self, member: Member) -> Member {
        Member {
            path: self.path(&member.path),
            ..member
        }
    }

    fn node(&self, node: TraceNode) -> TraceNode {
        TraceNode {
            path: node.path.as_deref().map(|path| self.path(path)),
            ..node
        }
    }

    fn component(&self, component: ComponentSummary) -> ComponentSummary {
        ComponentSummary {
            cover: component.cover.map(|cover| Cover {
                path: self.path(&cover.path),
                ..cover
            }),
            ..component
        }
    }
}

/// Whether the token reflects a recorded file's presence: only for files
/// directly inside the folder, through its mtime. Subfolder and external
/// parents, and unsaved outputs in managed storage, may change unseen.
fn presence_in_token(path: &str, folder: &Path) -> bool {
    classify(Path::new(path), folder, CASE_INSENSITIVE_PATHS).0 == NodeScope::Current
}

/// The current state of a recorded file that the token does not cover, so a
/// cached index never serves it stale. One metadata call per served item.
fn served_state(path: &str, folder: &Path) -> Option<NodeState> {
    (!presence_in_token(path, folder)).then(|| artifact_path_state(Path::new(path)).into())
}

fn refreshed_node(node: TraceNode, folder: &Path) -> TraceNode {
    let state = match (&node.path, node.artifact_id) {
        (Some(path), Some(_)) => served_state(path, folder),
        _ => None,
    };
    TraceNode {
        state: state.unwrap_or(node.state),
        ..node
    }
}

fn refreshed_component(component: ComponentSummary, folder: &Path) -> ComponentSummary {
    ComponentSummary {
        cover: component.cover.map(|cover| Cover {
            present: served_state(&cover.path, folder)
                .map_or(cover.present, |state| state == NodeState::Present),
            ..cover
        }),
        ..component
    }
}

fn valid_token(token: &str) -> Result<(), AppError> {
    if token.is_empty() || token.len() > MAX_TOKEN_CHARS {
        return Err(AppError::Other("Invalid Trace folder token".into()));
    }
    Ok(())
}

fn components_at(
    database: &Path,
    directory: &Path,
    offset: usize,
) -> Result<ComponentsPage, AppError> {
    let Current {
        token,
        index,
        folder,
    } = current_index(database, directory)?;
    let presentation = Presentation {
        folder: &folder,
        requested: directory,
    };
    Ok(ComponentsPage {
        token,
        total: index.components.len(),
        offset,
        components: page(&index.components, offset, COMPONENT_PAGE)
            .into_iter()
            .map(|component| presentation.component(refreshed_component(component, &folder)))
            .collect(),
    })
}

fn members_at(
    database: &Path,
    directory: &Path,
    token: &str,
    offset: usize,
) -> Result<MembersPage, AppError> {
    valid_token(token)?;
    let Current {
        token: current,
        index,
        folder,
    } = current_index(database, directory)?;
    if current != token {
        return Ok(MembersPage {
            stale: true,
            total: 0,
            offset,
            members: Vec::new(),
        });
    }
    let presentation = Presentation {
        folder: &folder,
        requested: directory,
    };
    Ok(MembersPage {
        stale: false,
        total: index.members.len(),
        offset,
        members: page(&index.members, offset, MEMBER_PAGE)
            .into_iter()
            .map(|member| presentation.member(member))
            .collect(),
    })
}

fn component_nodes_at(
    database: &Path,
    directory: &Path,
    token: &str,
    component_id: &str,
    offset: usize,
) -> Result<NodesPage, AppError> {
    valid_token(token)?;
    if component_id.is_empty() || component_id.len() > MAX_COMPONENT_ID_CHARS {
        return Err(AppError::Other("Invalid Trace component ID".into()));
    }
    let Current {
        token: current,
        index,
        folder,
    } = current_index(database, directory)?;
    if current != token {
        return Ok(NodesPage {
            stale: true,
            total: 0,
            offset,
            nodes: Vec::new(),
        });
    }
    let nodes = index
        .nodes
        .get(component_id)
        .ok_or_else(|| AppError::Other("Unknown Trace component".into()))?;
    let presentation = Presentation {
        folder: &folder,
        requested: directory,
    };
    Ok(NodesPage {
        stale: false,
        total: nodes.len(),
        offset,
        nodes: page(nodes, offset, NODE_PAGE)
            .into_iter()
            .map(|node| presentation.node(refreshed_node(node, &folder)))
            .collect(),
    })
}

fn run_details_at(database: &Path, run_ids: &[i64]) -> Result<Vec<Run>, AppError> {
    if run_ids.len() > MAX_RUN_DETAILS {
        return Err(AppError::Other(format!(
            "Trace run details accept at most {MAX_RUN_DETAILS} runs"
        )));
    }
    if run_ids.iter().any(|id| *id <= 0) {
        return Err(AppError::Other("Invalid provenance run ID".into()));
    }
    if run_ids.is_empty() || !database.exists() {
        return Ok(Vec::new());
    }
    let connection = connection_at(database)?;
    let snapshot = connection.unchecked_transaction().map_err(sql)?;
    let mut runs: HashMap<i64, Run> = batched(
        &snapshot,
        "SELECT id,operation,parameters,created_at,status,finished_at,error,recovered,result_details FROM runs WHERE id IN ({})",
        run_ids,
        read_run,
    )?
    .into_iter()
    .map(|run| (run.id, run))
    .collect();
    let ids: Vec<i64> = runs.keys().copied().collect();
    let mut inputs = HashMap::new();
    inputs_of(&snapshot, &ids, &mut inputs)?;
    let mut seen = HashSet::new();
    Ok(run_ids
        .iter()
        .filter(|id| seen.insert(**id))
        .filter_map(|id| {
            runs.remove(id).map(|mut run| {
                run.input_ids = inputs.remove(id).unwrap_or_default();
                run
            })
        })
        .collect())
}

fn revision_status_at(database: &Path, artifact_id: i64) -> Result<RevisionStatus, AppError> {
    if artifact_id <= 0 {
        return Err(AppError::Other("Invalid Trace artifact ID".into()));
    }
    let unknown = || AppError::Other("Unknown Trace artifact".into());
    if !database.exists() {
        return Err(unknown());
    }
    let (path, recorded): (String, String) = connection_at(database)?
        .query_row(
            "SELECT path,digest FROM artifacts WHERE id=?1",
            [artifact_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(sql)?
        .ok_or_else(unknown)?;
    let path = Path::new(&path);
    match artifact_path_state(path) {
        ArtifactPathState::Missing => return Ok(RevisionStatus::Missing),
        ArtifactPathState::Unavailable => return Ok(RevisionStatus::Unverified),
        ArtifactPathState::Present => {}
    }
    if fs::metadata(path)?.len() > MAX_IMAGE_BYTES {
        return Ok(RevisionStatus::Unverified);
    }
    Ok(match digest(path) {
        Ok(current) if current == recorded => RevisionStatus::Matched,
        Ok(_) => RevisionStatus::Changed,
        Err(AppError::NotFound(_)) => RevisionStatus::Missing,
        Err(_) => RevisionStatus::Unverified,
    })
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce(&Path) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(move || work(&database_path()?))
        .await
        .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

pub(crate) async fn components(
    directory: String,
    offset: usize,
) -> Result<ComponentsPage, AppError> {
    blocking(move |database| components_at(database, Path::new(&directory), offset)).await
}

pub(crate) async fn members(
    directory: String,
    token: String,
    offset: usize,
) -> Result<MembersPage, AppError> {
    blocking(move |database| members_at(database, Path::new(&directory), &token, offset)).await
}

pub(crate) async fn component_nodes(
    directory: String,
    token: String,
    component_id: String,
    offset: usize,
) -> Result<NodesPage, AppError> {
    blocking(move |database| {
        component_nodes_at(
            database,
            Path::new(&directory),
            &token,
            &component_id,
            offset,
        )
    })
    .await
}

pub(crate) async fn run_details(run_ids: Vec<i64>) -> Result<Vec<Run>, AppError> {
    blocking(move |database| run_details_at(database, &run_ids)).await
}

pub(crate) async fn revision_status(artifact_id: i64) -> Result<RevisionStatus, AppError> {
    blocking(move |database| revision_status_at(database, artifact_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = include_bytes!("../../test_support/fixtures/source32.png");

    struct Fixture {
        root: tempfile::TempDir,
        db: PathBuf,
        folder: PathBuf,
        generated: PathBuf,
        elsewhere: PathBuf,
    }

    fn fixture() -> Fixture {
        let root = crate::test_support::tempdir().unwrap();
        let db = root.path().join("trace.sqlite");
        let folder = root.path().join("folder");
        let generated = root.path().join("generated");
        let elsewhere = root.path().join("elsewhere");
        for directory in [&folder, &generated, &elsewhere] {
            fs::create_dir_all(directory).unwrap();
        }
        Fixture {
            root,
            db,
            folder,
            generated,
            elsewhere,
        }
    }

    fn image(path: &Path, bytes: &[u8]) -> PathBuf {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        path.to_owned()
    }

    fn input(path: &Path) -> OperationInput {
        OperationInput {
            path: path.to_string_lossy().into_owned(),
            digest: digest(path).unwrap(),
        }
    }

    /// Records `inputs -> output` and returns the generating run.
    fn record(f: &Fixture, parameters: serde_json::Value, inputs: &[&Path], output: &Path) -> i64 {
        record_operation_at(
            &f.db,
            OperationRecord {
                operation: "image.test".into(),
                parameters,
                inputs: inputs.iter().map(|path| input(path)).collect(),
                output_path: output.to_string_lossy().into_owned(),
                output_digest: digest(output).unwrap(),
            },
        )
        .unwrap();
        connection_at(&f.db)
            .unwrap()
            .query_row(
                "SELECT generating_run FROM artifacts ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn artifact(f: &Fixture, path: &Path) -> i64 {
        connection_at(&f.db)
            .unwrap()
            .query_row(
                "SELECT max(id) FROM artifacts WHERE path=?1",
                [path.to_string_lossy()],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn temporary(folder: &Path) -> serde_json::Value {
        serde_json::json!({"prompt":"a red fox","output_storage":"temporary","save_directory_hint":folder})
    }

    struct View {
        token: String,
        components: Vec<ComponentSummary>,
        nodes: HashMap<String, Vec<TraceNode>>,
        members: Vec<Member>,
    }

    impl View {
        fn node(&self, path: &Path) -> &TraceNode {
            let path = path.to_string_lossy();
            self.nodes
                .values()
                .flatten()
                .find(|node| node.path.as_deref() == Some(path.as_ref()))
                .unwrap_or_else(|| panic!("no node for {path}"))
        }
        fn keyed(&self, key: &str) -> &TraceNode {
            self.nodes
                .values()
                .flatten()
                .find(|node| node.key == key)
                .unwrap_or_else(|| panic!("no node {key}"))
        }
        fn component_of(&self, key: &str) -> &ComponentSummary {
            let id = self
                .nodes
                .iter()
                .find(|(_, nodes)| nodes.iter().any(|node| node.key == key))
                .map(|(id, _)| id)
                .unwrap();
            self.components.iter().find(|c| &c.id == id).unwrap()
        }
    }

    /// Reads every page of the folder index exactly as the UI does.
    fn view(f: &Fixture) -> View {
        view_at(f, &f.folder)
    }

    /// As `view`, with the folder requested through `directory`.
    fn view_at(f: &Fixture, directory: &Path) -> View {
        let mut components = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let page = components_at(&f.db, directory, components.len()).unwrap();
            assert_eq!(page.offset, components.len());
            assert!(page.components.len() <= COMPONENT_PAGE);
            if let Some(token) = &token {
                assert_eq!(token, &page.token, "index changed while paging");
            }
            token = Some(page.token);
            let done = page.components.is_empty();
            components.extend(page.components);
            if done || components.len() >= page.total {
                assert_eq!(components.len(), page.total);
                break;
            }
        }
        let token = token.unwrap();
        let mut nodes = HashMap::new();
        for component in &components {
            let mut all: Vec<TraceNode> = Vec::new();
            loop {
                let page =
                    component_nodes_at(&f.db, directory, &token, &component.id, all.len()).unwrap();
                assert!(!page.stale);
                let done = page.nodes.is_empty();
                all.extend(page.nodes);
                if done || all.len() >= page.total {
                    assert_eq!(all.len(), page.total);
                    break;
                }
            }
            assert_eq!(all.len(), component.node_count);
            nodes.insert(component.id.clone(), all);
        }
        let mut members = Vec::new();
        loop {
            let page = members_at(&f.db, directory, &token, members.len()).unwrap();
            assert!(!page.stale);
            let done = page.members.is_empty();
            members.extend(page.members);
            if done || members.len() >= page.total {
                assert_eq!(members.len(), page.total);
                break;
            }
        }
        View {
            token,
            components,
            nodes,
            members,
        }
    }

    fn publish(f: &Fixture, run: i64, output: &Path, bytes: &[u8]) {
        let directory = tempfile::Builder::new()
            .prefix(".tauri-explorer-stage-")
            .tempdir_in(&f.generated)
            .unwrap()
            .keep();
        let payload = directory.join("payload");
        let anchor = directory.join("trace-anchor");
        fs::write(&payload, bytes).unwrap();
        fs::hard_link(&payload, &anchor).unwrap();
        let output_digest = hex::encode(Sha256::digest(bytes));
        prepare_output_at(&f.db, run, output, &output_digest, Some(&anchor)).unwrap();
        fs::rename(payload, output).unwrap();
        complete_run_at(&f.db, run, output.to_str().unwrap(), false).unwrap();
    }

    #[test]
    fn one_source_with_many_children_is_one_component() {
        let f = fixture();
        let source = image(&f.folder.join("source.png"), b"source");
        let children: Vec<PathBuf> = (0..3)
            .map(|index| {
                let child = image(&f.folder.join(format!("child{index}.png")), &[index]);
                record(&f, serde_json::json!({}), &[&source], &child);
                child
            })
            .collect();
        let view = view(&f);
        let source_id = artifact(&f, &source);
        assert_eq!(view.components.len(), 1);
        let component = &view.components[0];
        assert_eq!(component.id, format!("c:a:{source_id}"));
        assert_eq!(component.title, "source");
        assert_eq!(
            component.cover,
            Some(Cover {
                path: source.to_string_lossy().into_owned(),
                present: true
            })
        );
        assert_eq!((component.image_count, component.node_count), (4, 4));
        assert!(!component.active && !component.unsaved);
        let source_key = format!("a:{source_id}");
        assert_eq!(view.node(&source).key, source_key);
        assert!(view.node(&source).parents.is_empty());
        for child in &children {
            let node = view.node(child);
            assert_eq!(node.parents, vec![source_key.clone()]);
            assert_eq!(node.scope, NodeScope::Current);
            assert_eq!(
                node.location,
                format!("./{}", child.file_name().unwrap().to_string_lossy())
            );
        }
        assert_eq!(view.members.len(), 4);
        assert!(view
            .members
            .iter()
            .all(|member| member.component_id == component.id));
        // Nodes come in stable creation order.
        let orders: Vec<i64> = view.nodes[&component.id].iter().map(|n| n.order).collect();
        assert!(orders.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn unrelated_chains_are_separate_components_newest_first() {
        let f = fixture();
        let a = image(&f.folder.join("a.png"), b"a");
        let b = image(&f.folder.join("b.png"), b"b");
        let c = image(&f.folder.join("c.png"), b"c");
        let d = image(&f.folder.join("d.png"), b"d");
        record(&f, serde_json::json!({}), &[&a], &b);
        record(&f, serde_json::json!({}), &[&c], &d);
        let view = view(&f);
        assert_eq!(view.components.len(), 2);
        assert_eq!(view.components[0].id, format!("c:a:{}", artifact(&f, &c)));
        assert_eq!(view.components[0].title, "c");
        assert_eq!(view.components[1].id, format!("c:a:{}", artifact(&f, &a)));
        assert_ne!(
            view.component_of(&view.node(&b).key).id,
            view.component_of(&view.node(&d).key).id
        );
    }

    #[test]
    fn shared_outside_input_joins_children_and_its_ancestors_stay_hidden() {
        let f = fixture();
        let grand = image(&f.elsewhere.join("grand.png"), b"grand");
        let shared = image(&f.elsewhere.join("shared.png"), b"shared");
        record(&f, serde_json::json!({}), &[&grand], &shared);
        let x = image(&f.folder.join("x.png"), b"x");
        let y = image(&f.folder.join("y.png"), b"y");
        record(&f, serde_json::json!({"prompt":"x"}), &[&shared], &x);
        record(&f, serde_json::json!({"prompt":"y"}), &[&shared], &y);
        let view = view(&f);
        assert_eq!(view.components.len(), 1);
        let component = &view.components[0];
        assert_eq!((component.node_count, component.image_count), (3, 2));
        assert_eq!(component.title, "x");
        let node = view.node(&shared);
        assert_eq!(node.scope, NodeScope::External);
        let path = shared.to_string_lossy();
        assert!(
            node.location == path || node.location.starts_with('~'),
            "{}",
            node.location
        );
        assert!(Path::new(&node.location).is_absolute() || node.location.starts_with("~"));
        assert!(
            node.parents.is_empty(),
            "ancestors of parents are not imported"
        );
        assert!(view
            .nodes
            .values()
            .flatten()
            .all(|n| n.path.as_deref() != Some(grand.to_string_lossy().as_ref())));
        assert_eq!(view.node(&x).parents, vec![node.key.clone()]);
        assert_eq!(view.node(&x).prompt, "x");
        assert_eq!(view.members.len(), 2);
    }

    #[test]
    fn subfolder_input_has_a_relative_location() {
        let f = fixture();
        let inner = image(&f.folder.join("sub").join("in.png"), b"in");
        let out = image(&f.folder.join("out.png"), b"out");
        record(&f, serde_json::json!({}), &[&inner], &out);
        let view = view(&f);
        let node = view.node(&inner);
        assert_eq!(node.scope, NodeScope::Subfolder);
        assert_eq!(
            node.location,
            Path::new("sub").join("in.png").to_string_lossy()
        );
        assert_eq!(view.members.len(), 1, "subfolder files are not members");
        assert_eq!(view.components[0].image_count, 1);
        assert_eq!(view.components[0].title, "out");
    }

    #[test]
    fn multi_input_runs_have_exact_deduplicated_parents_and_details() {
        let f = fixture();
        let a = image(&f.folder.join("a.png"), b"a");
        let b = image(&f.folder.join("b.png"), b"b");
        let c = image(&f.folder.join("c.png"), b"c");
        let d = image(&f.folder.join("d.png"), b"d");
        let run = record(&f, serde_json::json!({"prompt":"merge"}), &[&a, &b, &a], &c);
        record(&f, serde_json::json!({}), &[&b], &d);
        let view = view(&f);
        let (a_key, b_key) = (view.node(&a).key.clone(), view.node(&b).key.clone());
        assert_eq!(view.node(&c).parents, vec![a_key, b_key.clone()]);
        assert_eq!(view.node(&d).parents, vec![b_key]);
        assert_eq!(view.node(&c).key, format!("o:{run}:0"));
        assert_eq!(view.node(&c).run_id, Some(run));
        assert_eq!(view.components.len(), 1);
        let details = run_details_at(&f.db, &[run, run, 999_999]).unwrap();
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].id, run);
        assert_eq!(
            details[0].input_ids,
            vec![artifact(&f, &a), artifact(&f, &b), artifact(&f, &a)]
        );
        assert_eq!(details[0].parameters["prompt"], "merge");
        assert!(run_details_at(&f.db, &[]).unwrap().is_empty());
    }

    #[test]
    fn saving_a_temporary_output_keeps_its_key() {
        let f = fixture();
        let source = image(&f.folder.join("source.png"), b"source");
        let temp = image(&f.generated.join("fox.png"), PNG);
        let run = record(&f, temporary(&f.folder), &[&source], &temp);
        let id = artifact(&f, &temp);
        let before = view(&f);
        let key = format!("o:{run}:0");
        let node = before.keyed(&key);
        assert_eq!(node.artifact_id, Some(id));
        assert!(node.temporary);
        assert_eq!(node.scope, NodeScope::Current);
        assert_eq!(node.location, TEMPORARY_LOCATION);
        assert_eq!(node.prompt, "a red fox");
        assert_eq!(node.parents, vec![before.node(&source).key.clone()]);
        let component = before.component_of(&key);
        assert!(component.unsaved);
        assert_eq!(component.image_count, 2);
        assert_eq!(component.title, "source");
        assert_eq!(
            before.members.len(),
            1,
            "unsaved outputs are not folder files"
        );

        let target = f.folder.join("saved.png");
        save::save_at(&f.db, &f.generated, id, &target).unwrap();
        let after = view(&f);
        assert_ne!(after.token, before.token);
        let node = after.keyed(&key);
        assert_eq!(node.artifact_id, Some(id));
        assert!(!node.temporary);
        assert_eq!(
            node.path.as_deref(),
            Some(target.to_string_lossy().as_ref())
        );
        assert_eq!(node.location, "./saved.png");
        assert!(!after.component_of(&key).unsaved);
        assert!(after
            .members
            .iter()
            .any(|member| member.key == key && member.path == target.to_string_lossy()));
    }

    #[test]
    fn running_generation_placeholder_becomes_the_completed_output_key() {
        let f = fixture();
        let source = image(&f.folder.join("source.png"), b"source");
        let run = begin_operation_at(
            &f.db,
            OperationStart {
                operation: "openai.image.edit".into(),
                parameters: temporary(&f.folder),
                inputs: vec![input(&source)],
            },
        )
        .unwrap();
        let lone = begin_operation_at(
            &f.db,
            OperationStart {
                operation: "openai.image.generate".into(),
                parameters: temporary(&f.folder),
                inputs: vec![],
            },
        )
        .unwrap();
        let key = format!("o:{run}:0");
        let running = view(&f);
        let placeholder = running.keyed(&key);
        assert_eq!(placeholder.artifact_id, None);
        assert_eq!(placeholder.run_id, Some(run));
        assert_eq!(placeholder.state, NodeState::Running);
        assert_eq!(placeholder.location, PLACEHOLDER_LOCATION);
        assert_eq!(placeholder.order, PLACEHOLDER_ORDER + run);
        assert_eq!(placeholder.parents, vec![running.node(&source).key.clone()]);
        let component = running.component_of(&key);
        assert!(component.active);
        assert_eq!(component.id, format!("c:a:{}", artifact(&f, &source)));
        let alone = running.component_of(&format!("o:{lone}:0"));
        assert_eq!(alone.id, format!("c:o:{lone}:0"));
        assert_eq!(alone.title, "Generating");
        assert_eq!(alone.cover, None);
        assert!(alone.active);
        // Newest first: the lone generation started last.
        assert_eq!(running.components[0].id, alone.id);

        mark_operation_uncertain(
            &TraceRunHandle {
                database: f.db.clone(),
                id: lone,
            },
            "test",
        )
        .unwrap();
        assert_eq!(
            view(&f).keyed(&format!("o:{lone}:0")).state,
            NodeState::Uncertain
        );

        let output = f.generated.join("edit.png");
        publish(&f, run, &output, b"edited");
        let done = view(&f);
        let node = done.keyed(&key);
        assert_eq!(node.artifact_id, Some(artifact(&f, &output)));
        assert_eq!(node.state, NodeState::Present);
        assert!(node.temporary);
        assert!(!done.component_of(&key).active);
    }

    #[test]
    fn discarded_parent_is_kept_and_marked() {
        let f = fixture();
        let temp = image(&f.generated.join("draft.png"), PNG);
        record(&f, temporary(&f.folder), &[], &temp);
        let draft = artifact(&f, &temp);
        let child = image(&f.folder.join("child.png"), b"child");
        record(&f, serde_json::json!({}), &[&temp], &child);
        save::discard_at(&f.db, &f.generated, draft).unwrap();
        let view = view(&f);
        assert_eq!(view.components.len(), 1);
        assert_eq!(view.components[0].node_count, 2);
        let parent = view.node(&temp);
        assert!(parent.discarded);
        assert_eq!(parent.state, NodeState::Missing);
        assert_eq!(view.node(&child).parents, vec![parent.key.clone()]);
        assert_eq!(view.components[0].image_count, 1);
    }

    #[test]
    fn earlier_revision_is_flagged_and_members_map_to_the_newest() {
        let f = fixture();
        let path = image(&f.folder.join("photo.png"), b"original");
        let original = input(&path);
        fs::write(&path, b"edited in place").unwrap();
        record_operation_at(
            &f.db,
            OperationRecord {
                operation: "image.crop".into(),
                parameters: serde_json::json!({}),
                inputs: vec![original],
                output_path: path.to_string_lossy().into_owned(),
                output_digest: digest(&path).unwrap(),
            },
        )
        .unwrap();
        let view = view(&f);
        let nodes = &view.nodes[&view.components[0].id];
        assert_eq!(nodes.len(), 2);
        assert!(nodes[0].earlier_revision);
        assert!(nodes[0].key.starts_with("a:"));
        assert!(!nodes[1].earlier_revision);
        assert_eq!(nodes[1].parents, vec![nodes[0].key.clone()]);
        assert_eq!(view.members.len(), 1);
        assert_eq!(view.members[0].key, nodes[1].key);
        assert_eq!(view.components[0].title, "photo");
        assert_eq!(view.components[0].image_count, 1, "one file, two revisions");
    }

    fn bulk(db: &Path, write: impl FnOnce(&rusqlite::Transaction<'_>)) {
        let mut connection = connection_at(db).unwrap();
        let tx = connection.transaction().unwrap();
        write(&tx);
        tx.commit().unwrap();
    }

    fn insert_artifact(tx: &rusqlite::Transaction<'_>, path: &Path, run: Option<i64>) -> i64 {
        tx.execute(
            "INSERT INTO artifacts(path,digest,generating_run) VALUES(?1,?2,?3)",
            params![path.to_string_lossy(), "0".repeat(64), run],
        )
        .unwrap();
        tx.last_insert_rowid()
    }

    fn insert_derived(tx: &rusqlite::Transaction<'_>, parent: i64, path: &Path) -> i64 {
        tx.execute(
            "INSERT INTO runs(operation,parameters,status) VALUES('image.crop','{}','succeeded')",
            [],
        )
        .unwrap();
        let run = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO run_inputs(run_id,artifact_id,position) VALUES(?1,?2,0)",
            params![run, parent],
        )
        .unwrap();
        insert_artifact(tx, path, Some(run))
    }

    #[test]
    fn pages_cover_every_member_and_component_without_truncation() {
        let f = fixture();
        let paths: Vec<PathBuf> = (0..2500)
            .map(|index| image(&f.folder.join(format!("{index:05}.png")), b"x"))
            .collect();
        bulk(&f.db, |tx| {
            for path in &paths {
                insert_artifact(tx, path, None);
            }
        });
        let first = members_at(
            &f.db,
            &f.folder,
            &components_at(&f.db, &f.folder, 0).unwrap().token,
            0,
        )
        .unwrap();
        assert_eq!((first.total, first.members.len()), (2500, MEMBER_PAGE));
        let view = view(&f);
        assert_eq!(view.components.len(), 2500);
        assert_eq!(view.members.len(), 2500);
        let unique: HashSet<&str> = view.members.iter().map(|m| m.path.as_str()).collect();
        assert_eq!(unique.len(), 2500);
        let last = members_at(&f.db, &f.folder, &view.token, 2000).unwrap();
        assert_eq!((last.offset, last.members.len()), (2000, 500));
        let beyond = members_at(&f.db, &f.folder, &view.token, 9999).unwrap();
        assert!(!beyond.stale && beyond.members.is_empty() && beyond.total == 2500);
        let pages: Vec<usize> = (0..13)
            .map(|page| {
                components_at(&f.db, &f.folder, page * COMPONENT_PAGE)
                    .unwrap()
                    .components
                    .len()
            })
            .collect();
        assert_eq!(pages[..12], [COMPONENT_PAGE; 12]);
        assert_eq!(pages[12], 100);
    }

    #[test]
    fn long_entries_shorten_pages_below_the_frame_limit_but_never_drop_items() {
        let f = fixture();
        // Long, but within macOS's 1024-byte path limit.
        let deep = (0..5).fold(f.folder.clone(), |path, index| {
            path.join(format!("{index:02}{}", "d".repeat(150)))
        });
        let inputs: Vec<PathBuf> = (0..400)
            .map(|index| {
                image(
                    &deep.join(format!("{index:04}{}.png", "n".repeat(100))),
                    b"x",
                )
            })
            .collect();
        let output = image(&f.folder.join("joined.png"), b"joined");
        bulk(&f.db, |tx| {
            let ids: Vec<i64> = inputs
                .iter()
                .map(|path| insert_artifact(tx, path, None))
                .collect();
            tx.execute(
                "INSERT INTO runs(operation,parameters,status) VALUES('image.merge','{}','succeeded')",
                [],
            )
            .unwrap();
            let run = tx.last_insert_rowid();
            for (position, id) in ids.iter().enumerate() {
                tx.execute(
                    "INSERT INTO run_inputs(run_id,artifact_id,position) VALUES(?1,?2,?3)",
                    params![run, id, position as i64],
                )
                .unwrap();
            }
            insert_artifact(tx, &output, Some(run));
        });
        let page = components_at(&f.db, &f.folder, 0).unwrap();
        let first =
            component_nodes_at(&f.db, &f.folder, &page.token, &page.components[0].id, 0).unwrap();
        assert_eq!(first.total, 401);
        assert!(first.nodes.len() < 401);
        assert!(serde_json::to_vec(&first).unwrap().len() < MAX_MESSAGE_BYTES_FOR_TEST);
        let view = view(&f);
        assert_eq!(view.nodes[&view.components[0].id].len(), 401);
    }

    const MAX_MESSAGE_BYTES_FOR_TEST: usize = crate::protocol::MAX_MESSAGE_BYTES / 2 + 64 * 1024;

    #[test]
    fn any_recorded_change_expires_the_token() {
        let f = fixture();
        let a = image(&f.folder.join("a.png"), b"a");
        let b = image(&f.folder.join("b.png"), b"b");
        record(&f, serde_json::json!({}), &[&a], &b);
        let first = components_at(&f.db, &f.folder, 0).unwrap();
        assert_eq!(
            components_at(&f.db, &f.folder, 0).unwrap().token,
            first.token
        );
        let component = first.components[0].id.clone();

        // A change elsewhere leaves this folder's mtime alone.
        let other = image(&f.elsewhere.join("other.png"), b"other");
        let other_out = image(&f.elsewhere.join("other_out.png"), b"other out");
        record(&f, serde_json::json!({}), &[&other], &other_out);
        assert!(members_at(&f.db, &f.folder, &first.token, 0).unwrap().stale);
        let nodes = component_nodes_at(&f.db, &f.folder, &first.token, &component, 0).unwrap();
        assert!(nodes.stale && nodes.nodes.is_empty() && nodes.total == 0);

        // Writers outside this process are seen as well.
        let second = components_at(&f.db, &f.folder, 0).unwrap();
        assert_ne!(second.token, first.token);
        assert!(
            !members_at(&f.db, &f.folder, &second.token, 0)
                .unwrap()
                .stale
        );
        rusqlite::Connection::open(&f.db)
            .unwrap()
            .execute(
                "UPDATE runs SET status='failed' WHERE id=(SELECT max(id) FROM runs)",
                [],
            )
            .unwrap();
        assert!(
            members_at(&f.db, &f.folder, &second.token, 0)
                .unwrap()
                .stale
        );
        assert!(
            members_at(&f.db, &f.folder, "not-a-token", 0)
                .unwrap()
                .stale
        );
    }

    #[test]
    fn removing_an_unsaved_output_outside_the_folder_expires_the_token() {
        let f = fixture();
        let temp = image(&f.generated.join("draft.png"), PNG);
        record(&f, temporary(&f.folder), &[], &temp);
        let modified = fs::metadata(&f.folder).unwrap().modified().unwrap();
        let first = view(&f);
        assert_eq!(first.components.len(), 1);
        fs::remove_file(&temp).unwrap();
        assert_eq!(
            fs::metadata(&f.folder).unwrap().modified().unwrap(),
            modified
        );
        assert!(members_at(&f.db, &f.folder, &first.token, 0).unwrap().stale);
        assert_eq!(view(&f).components.len(), 0);
        fs::write(&temp, PNG).unwrap();
        assert_eq!(view(&f).components.len(), 1);
    }

    #[test]
    fn files_without_provenance_are_not_members() {
        let f = fixture();
        let source = image(&f.folder.join("source.png"), b"source");
        let traced = image(&f.folder.join("traced.png"), b"traced");
        image(&f.folder.join("plain.png"), b"plain");
        record(&f, serde_json::json!({}), &[&source], &traced);
        let view = view(&f);
        let mut paths: Vec<&str> = view.members.iter().map(|m| m.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, [source.to_string_lossy(), traced.to_string_lossy()]);
        fs::remove_file(&traced).unwrap();
        let view = super::tests::view(&f);
        assert_eq!(view.members.len(), 1);
        assert_eq!(view.components.len(), 1);
        assert_eq!(
            view.components[0].node_count, 1,
            "a removed file is no longer a seed"
        );
    }

    #[test]
    fn empty_and_untraced_folders_have_no_components() {
        let f = fixture();
        let page = components_at(&f.db, &f.folder, 0).unwrap();
        assert_eq!((page.total, page.components.len()), (0, 0));
        assert!(!f.db.exists(), "queries do not create the journal");
        image(&f.elsewhere.join("a.png"), b"a");
        let a = f.elsewhere.join("a.png");
        let b = image(&f.elsewhere.join("b.png"), b"b");
        record(&f, serde_json::json!({}), &[&a], &b);
        assert_eq!(components_at(&f.db, &f.folder, 0).unwrap().total, 0);
    }

    #[test]
    fn malformed_requests_are_rejected() {
        let f = fixture();
        let a = image(&f.folder.join("a.png"), b"a");
        let b = image(&f.folder.join("b.png"), b"b");
        record(&f, serde_json::json!({}), &[&a], &b);
        assert!(components_at(&f.db, Path::new("relative/folder"), 0).is_err());
        assert!(components_at(&f.db, &f.root.path().join("absent"), 0).is_err());
        assert!(
            components_at(&f.db, &a, 0).is_err(),
            "a file is not a folder"
        );
        let token = components_at(&f.db, &f.folder, 0).unwrap().token;
        assert!(members_at(&f.db, &f.folder, "", 0).is_err());
        assert!(members_at(&f.db, &f.folder, &"x".repeat(500), 0).is_err());
        assert!(component_nodes_at(&f.db, &f.folder, &token, "", 0).is_err());
        assert!(component_nodes_at(&f.db, &f.folder, &token, "c:999999", 0).is_err());
        assert!(run_details_at(&f.db, &vec![1; MAX_RUN_DETAILS + 1]).is_err());
        assert!(run_details_at(&f.db, &[0]).is_err());
        assert!(run_details_at(&f.db, &[-4]).is_err());
        assert!(revision_status_at(&f.db, 0).is_err());
        assert!(revision_status_at(&f.db, 999_999).is_err());
    }

    #[test]
    fn revision_status_hashes_only_the_requested_revision() {
        let f = fixture();
        let a = image(&f.folder.join("a.png"), b"a");
        let b = image(&f.folder.join("b.png"), b"b");
        record(&f, serde_json::json!({}), &[&a], &b);
        let (a_id, b_id) = (artifact(&f, &a), artifact(&f, &b));
        assert_eq!(
            revision_status_at(&f.db, b_id).unwrap(),
            RevisionStatus::Matched
        );
        fs::write(&b, b"changed").unwrap();
        assert_eq!(
            revision_status_at(&f.db, b_id).unwrap(),
            RevisionStatus::Changed
        );
        OpenOptions::new()
            .write(true)
            .open(&b)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        assert_eq!(
            revision_status_at(&f.db, b_id).unwrap(),
            RevisionStatus::Unverified
        );
        fs::remove_file(&a).unwrap();
        assert_eq!(
            revision_status_at(&f.db, a_id).unwrap(),
            RevisionStatus::Missing
        );
        assert_eq!(
            serde_json::to_value(RevisionStatus::Unverified).unwrap(),
            "unverified"
        );
    }

    #[test]
    fn nodes_serialize_with_the_client_field_names() {
        let node = TraceNode {
            key: "o:1:0".into(),
            artifact_id: Some(2),
            run_id: Some(1),
            parents: vec!["a:1".into()],
            path: Some("/x/y.png".into()),
            scope: NodeScope::Subfolder,
            location: "y.png".into(),
            state: NodeState::Uncertain,
            temporary: true,
            discarded: false,
            earlier_revision: true,
            order: 2,
            prompt: String::new(),
        };
        let value = serde_json::to_value(&node).unwrap();
        assert_eq!(value["artifactId"], 2);
        assert_eq!(value["runId"], 1);
        assert_eq!(value["earlierRevision"], true);
        assert_eq!(value["scope"], "subfolder");
        assert_eq!(value["state"], "uncertain");
        let member = serde_json::to_value(Member {
            path: "/x".into(),
            component_id: "c:1".into(),
            key: "a:1".into(),
        })
        .unwrap();
        assert_eq!(member["componentId"], "c:1");
        let summary = serde_json::to_value(ComponentSummary {
            id: "c:1".into(),
            title: "t".into(),
            cover: None,
            image_count: 1,
            node_count: 2,
            active: false,
            unsaved: false,
        })
        .unwrap();
        assert_eq!(summary["imageCount"], 1);
        assert_eq!(summary["nodeCount"], 2);
        assert!(summary["cover"].is_null());
    }

    // Unix path syntax; Windows applies the same rules to its native paths.
    #[cfg(not(windows))]
    #[test]
    fn scope_and_location_follow_native_path_rules() {
        let folder = Path::new("/data/Pictures");
        let layout = Layout {
            folder,
            home: Some(Path::new("/home/user")),
            case_insensitive: false,
        };
        let cases = [
            (
                "/data/Pictures/a.png",
                NodeScope::Current,
                "./a.png".to_owned(),
            ),
            (
                "/data/Pictures/trip/day/b.png",
                NodeScope::Subfolder,
                Path::new("trip")
                    .join("day")
                    .join("b.png")
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "/data/PicturesOld/c.png",
                NodeScope::External,
                "/data/PicturesOld/c.png".to_owned(),
            ),
            (
                "/data/pictures/d.png",
                NodeScope::External,
                "/data/pictures/d.png".to_owned(),
            ),
            (
                "/home/user/e.png",
                NodeScope::External,
                format!("~{}e.png", std::path::MAIN_SEPARATOR),
            ),
            (
                "/home/username/f.png",
                NodeScope::External,
                "/home/username/f.png".to_owned(),
            ),
        ];
        for (path, scope, expected) in cases {
            let (actual, relative) = classify(Path::new(path), folder, false);
            assert_eq!(actual, scope, "{path}");
            assert_eq!(
                location(Path::new(path), actual, relative.as_deref(), &layout),
                expected
            );
        }
        assert_eq!(classify(folder, folder, false).0, NodeScope::External);
        // Case-insensitive volumes (Windows) match differently cased spellings.
        assert_eq!(
            classify(Path::new("/DATA/pictures/a.png"), folder, true).0,
            NodeScope::Current
        );
        assert_eq!(
            relative_within(
                Path::new("/Home/User/x/y.png"),
                Path::new("/home/user"),
                true
            ),
            Some(PathBuf::from("x/y.png"))
        );
        assert_eq!(
            external_location(
                Path::new("/home/user"),
                Some(Path::new("/home/user")),
                false
            ),
            "~"
        );
        assert_eq!(
            external_location(Path::new("/srv/z.png"), None, false),
            "/srv/z.png"
        );
    }

    #[test]
    fn prompts_are_truncated_on_character_boundaries() {
        assert_eq!(truncate_prompt("short"), "short");
        let long = "é".repeat(400);
        let truncated = truncate_prompt(&long);
        assert_eq!(truncated.chars().count(), MAX_PROMPT_CHARS);
        assert!(long.starts_with(&truncated));
        assert_eq!(truncate_prompt(""), "");
    }

    #[test]
    fn change_counter_installs_once_and_survives_reopen() {
        let f = fixture();
        let a = image(&f.folder.join("a.png"), b"a");
        let b = image(&f.folder.join("b.png"), b"b");
        record(&f, serde_json::json!({}), &[&a], &b);
        let read = || -> i64 {
            connection_at(&f.db)
                .unwrap()
                .query_row("SELECT value FROM trace_revision", [], |row| row.get(0))
                .unwrap()
        };
        let before = read();
        assert!(before > 0);
        assert_eq!(read(), before, "opening a connection is not a change");
        let version: i64 = connection_at(&f.db)
            .unwrap()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 8);
        relocate_at(&f.db, &b, &{
            let moved = f.folder.join("moved.png");
            fs::rename(&b, &moved).unwrap();
            moved
        })
        .unwrap();
        assert!(read() > before, "relocation is a change");
    }

    #[cfg(unix)]
    #[test]
    fn paths_inside_an_aliased_folder_are_expressed_under_the_requested_directory() {
        let f = fixture();
        let link = f.root.path().join("link");
        std::os::unix::fs::symlink(&f.folder, &link).unwrap();
        let source = image(&f.folder.join("source.png"), b"source");
        let inner = image(&f.folder.join("sub").join("in.png"), b"in");
        let outside = image(&f.elsewhere.join("out.png"), b"out");
        let child = image(&f.folder.join("child.png"), b"child");
        record(&f, serde_json::json!({}), &[&source], &child);
        let joined = image(&f.folder.join("joined.png"), b"joined");
        record(
            &f,
            serde_json::json!({}),
            &[&child, &inner, &outside],
            &joined,
        );
        let under_link = |path: &Path| {
            link.join(path.strip_prefix(&f.folder).unwrap())
                .to_string_lossy()
                .into_owned()
        };
        let canonical = view(&f);
        let aliased = view_at(&f, &link);
        assert_eq!(aliased.token, canonical.token);

        // Members match the Explorer entries listed from the requested path.
        let mut members: Vec<&str> = aliased.members.iter().map(|m| m.path.as_str()).collect();
        members.sort_unstable();
        assert_eq!(
            members,
            [under_link(&child), under_link(&joined), under_link(&source)]
        );
        // Nodes in the folder tree follow it; identity and locations do not change.
        for node in canonical.nodes.values().flatten() {
            let shown = aliased.keyed(&node.key);
            let expected = match node.scope {
                NodeScope::External => node.path.clone(),
                _ => node.path.as_deref().map(|path| under_link(Path::new(path))),
            };
            assert_eq!(shown.path, expected, "{}", node.key);
            assert_eq!(
                (shown.artifact_id, shown.scope, &shown.location, shown.state),
                (node.artifact_id, node.scope, &node.location, node.state)
            );
        }
        assert_eq!(
            aliased.node(Path::new(&under_link(&inner))).location,
            Path::new("sub").join("in.png").to_string_lossy()
        );
        assert_eq!(aliased.node(&outside).scope, NodeScope::External);
        let component = &aliased.components[0];
        assert_eq!(component.id, canonical.components[0].id);
        assert_eq!(component.cover.as_ref().unwrap().path, under_link(&source));

        // A trailing separator is part of the requested spelling.
        let trailing = PathBuf::from(format!("{}{}", link.display(), std::path::MAIN_SEPARATOR));
        let page = members_at(&f.db, &trailing, &aliased.token, 0).unwrap();
        assert!(page.members.iter().any(|m| m.path == under_link(&child)));

        // Actions keyed by artifact ID are unaffected by the spelling.
        let id = aliased
            .node(Path::new(&under_link(&child)))
            .artifact_id
            .unwrap();
        assert_eq!(
            revision_status_at(&f.db, id).unwrap(),
            RevisionStatus::Matched
        );
    }

    // Unix path syntax; Windows applies the same rules to its native paths.
    #[cfg(not(windows))]
    #[test]
    fn requested_spelling_replaces_only_the_folder_prefix() {
        let folder = Path::new("/private/tmp/Pics");
        let requested = Path::new("/tmp/pics");
        let shown =
            |path: &str, case_insensitive| as_requested(path, folder, requested, case_insensitive);
        assert_eq!(shown("/private/tmp/Pics/a.png", false), "/tmp/pics/a.png");
        assert_eq!(
            shown("/private/tmp/Pics/sub/b.png", false),
            "/tmp/pics/sub/b.png"
        );
        // A differently cased record matches only where paths ignore case.
        assert_eq!(shown("/PRIVATE/tmp/pics/a.png", true), "/tmp/pics/a.png");
        assert_eq!(
            shown("/PRIVATE/tmp/pics/a.png", false),
            "/PRIVATE/tmp/pics/a.png"
        );
        for unchanged in [
            "/private/tmp/PicsOld/a.png",
            "/private/tmp/Pics",
            "/srv/a.png",
            "",
        ] {
            assert_eq!(shown(unchanged, false), unchanged);
        }
        assert_eq!(
            as_requested("/private/tmp/Pics/a.png", folder, folder, false),
            "/private/tmp/Pics/a.png"
        );
    }

    #[test]
    fn component_id_survives_completion_saving_and_new_descendants() {
        let f = fixture();
        // Later run IDs gain a digit, so they sort before the first lexically.
        bulk(&f.db, |tx| {
            for _ in 0..8 {
                tx.execute(
                    "INSERT INTO runs(operation,parameters,status) VALUES('image.test','{}','failed')",
                    [],
                )
                .unwrap();
            }
        });
        let lone = begin_operation_at(
            &f.db,
            OperationStart {
                operation: "openai.image.generate".into(),
                parameters: temporary(&f.folder),
                inputs: vec![],
            },
        )
        .unwrap();
        assert_eq!(lone, 9);
        let key = format!("o:{lone}:0");
        let running = view(&f).component_of(&key).id.clone();
        assert_eq!(running, format!("c:{key}"));

        let output = f.generated.join("gen.png");
        publish(&f, lone, &output, b"generated");
        assert_eq!(view(&f).component_of(&key).id, running, "completion");

        let saved = f.folder.join("saved.png");
        save::save_at(&f.db, &f.generated, artifact(&f, &output), &saved).unwrap();
        assert_eq!(view(&f).component_of(&key).id, running, "saving");

        let child = image(&f.folder.join("child.png"), b"child");
        let derived = record(&f, serde_json::json!({}), &[&saved], &child);
        assert!(derived >= 10);
        let extended = view(&f);
        assert_eq!(extended.components.len(), 1);
        assert_eq!(extended.component_of(&key).id, running, "new descendant");
    }

    #[test]
    fn component_ids_prefer_sources_then_the_oldest_output() {
        let id = |identities: &[NodeIdentity]| component_id(identities.iter().copied());
        let output = |run, index| NodeIdentity::Output { run, index };
        assert_eq!(id(&[output(9, 0), output(10, 0)]), "c:o:9:0");
        assert_eq!(id(&[output(9, 1), output(9, 0)]), "c:o:9:0");
        assert_eq!(
            id(&[output(1, 0), NodeIdentity::Source(12)]),
            "c:a:12",
            "a recorded source is the root of the generations it feeds"
        );
        assert_eq!(id(&[]), "");
    }

    #[test]
    fn parents_outside_the_folder_report_their_presence_when_served() {
        let f = fixture();
        let parent = image(&f.elsewhere.join("parent.png"), b"parent");
        let inner = image(&f.folder.join("sub").join("in.png"), b"in");
        // An unsaved output meant for another folder.
        let draft = image(&f.generated.join("draft.png"), PNG);
        record(&f, temporary(&f.elsewhere), &[], &draft);
        let child = image(&f.folder.join("child.png"), b"child");
        record(
            &f,
            serde_json::json!({}),
            &[&parent, &inner, &draft],
            &child,
        );
        let before = view(&f);
        for path in [&parent, &inner, &draft] {
            assert_eq!(before.node(path).state, NodeState::Present);
        }

        for path in [&parent, &inner, &draft] {
            fs::remove_file(path).unwrap();
        }
        let after = view(&f);
        assert_eq!(after.token, before.token, "the folder itself is unchanged");
        for path in [&parent, &inner, &draft] {
            assert_eq!(after.node(path).state, NodeState::Missing);
        }
        assert_eq!(after.node(&child).state, NodeState::Present);

        image(&parent, b"parent");
        assert_eq!(view(&f).node(&parent).state, NodeState::Present);
    }

    #[test]
    fn a_cover_outside_the_folder_reports_its_presence_when_served() {
        let f = fixture();
        let parent = image(&f.elsewhere.join("parent.png"), b"parent");
        let run = begin_operation_at(
            &f.db,
            OperationStart {
                operation: "openai.image.edit".into(),
                parameters: temporary(&f.folder),
                inputs: vec![input(&parent)],
            },
        )
        .unwrap();
        let key = format!("o:{run}:0");
        let cover = |view: &View| view.component_of(&key).cover.clone().unwrap();
        assert_eq!(
            cover(&view(&f)),
            Cover {
                path: parent.to_string_lossy().into_owned(),
                present: true
            }
        );
        fs::remove_file(&parent).unwrap();
        assert!(!cover(&view(&f)).present);
    }

    #[test]
    fn interrupted_unsaved_output_makes_a_folder_eligible_exactly_while_indexed() {
        let f = fixture();
        let interrupt = |run: i64| {
            connection_at(&f.db)
                .unwrap()
                .execute("UPDATE runs SET status='interrupted' WHERE id=?1", [run])
                .unwrap();
        };
        let eligible = || folders::has_trace_at(&f.db, &f.folder).unwrap();
        // Interrupted before any output: nothing to show.
        let empty = begin_operation_at(
            &f.db,
            OperationStart {
                operation: "openai.image.generate".into(),
                parameters: temporary(&f.folder),
                inputs: vec![],
            },
        )
        .unwrap();
        interrupt(empty);
        assert_eq!(view(&f).components.len(), 0);
        assert!(!eligible());

        let temp = image(&f.generated.join("draft.png"), PNG);
        let run = record(&f, temporary(&f.folder), &[], &temp);
        interrupt(run);
        assert_eq!(view(&f).components.len(), 1);
        assert!(eligible());

        fs::remove_file(&temp).unwrap();
        assert_eq!(view(&f).components.len(), 0);
        assert!(!eligible());

        fs::write(&temp, PNG).unwrap();
        assert_eq!(view(&f).components.len(), 1);
        assert!(eligible());
    }

    #[test]
    fn newest_revision_per_path_follows_the_volume_case_rule() {
        let revisions = [
            (1, "/f/photo.png"),
            (3, "/f/Photo.PNG"),
            (2, "/f/other.png"),
        ];
        let insensitive = newest_by_path(revisions, true);
        assert_eq!(insensitive.len(), 2);
        assert_eq!(insensitive[&path_identity("/F/PHOTO.png", true)], 3);
        let sensitive = newest_by_path(revisions, false);
        assert_eq!(sensitive.len(), 3);
        assert_eq!(sensitive[&path_identity("/f/photo.png", false)], 1);
        assert!(newest_by_path([], true).is_empty());
    }

    /// Builds the index directly with an explicit case rule, so the rule can
    /// be exercised on a case-sensitive test filesystem.
    fn index_with(f: &Fixture, case_insensitive: bool) -> FolderIndex {
        let folder = folders::key(&f.folder).unwrap();
        let layout = Layout {
            folder: Path::new(&folder),
            home: None,
            case_insensitive,
        };
        let connection = connection_at(&f.db).unwrap();
        let loaded = load_snapshot(&connection, &folder, &layout).unwrap();
        build_index(&resolve_facts(loaded), &layout)
    }

    #[test]
    fn a_case_only_rename_is_one_member_where_paths_ignore_case() {
        let f = fixture();
        let original = image(&f.folder.join("photo.png"), b"original");
        let before = input(&original);
        // A real case-only rename, then an edit: on a case-insensitive
        // filesystem writing "Photo.png" beside "photo.png" would only
        // overwrite it under its old name.
        let renamed = f.folder.join("Photo.png");
        fs::rename(&original, &renamed).unwrap();
        fs::write(&renamed, b"renamed and edited").unwrap();
        record_operation_at(
            &f.db,
            OperationRecord {
                operation: "image.test".into(),
                parameters: serde_json::json!({}),
                inputs: vec![before],
                output_path: renamed.to_string_lossy().into_owned(),
                output_digest: digest(&renamed).unwrap(),
            },
        )
        .unwrap();

        let insensitive = index_with(&f, true);
        assert_eq!(insensitive.components.len(), 1);
        let paths: Vec<&str> = insensitive
            .members
            .iter()
            .map(|m| m.path.as_str())
            .collect();
        assert_eq!(paths, [renamed.to_string_lossy()]);
        assert_eq!(
            insensitive.components[0].image_count, 1,
            "one file, two revisions"
        );
        let nodes = &insensitive.nodes[&insensitive.components[0].id];
        let earlier = nodes
            .iter()
            .find(|node| node.path.as_deref() == Some(original.to_string_lossy().as_ref()))
            .unwrap();
        assert!(earlier.earlier_revision);

        // Where case matters, the old name is a different image, not an
        // earlier revision of the renamed one.
        let sensitive = index_with(&f, false);
        let old = sensitive.nodes[&sensitive.components[0].id]
            .iter()
            .find(|node| node.path.as_deref() == Some(original.to_string_lossy().as_ref()))
            .unwrap();
        assert!(!old.earlier_revision);
    }

    /// Run with `cargo test --release -- --ignored folder_index_benchmark --nocapture`.
    #[test]
    #[ignore]
    fn folder_index_benchmark() {
        let f = fixture();
        let mut paths = (0..).map(|index| f.folder.join(format!("{index:06}.png")));
        let mut created = Vec::new();
        bulk(&f.db, |tx| {
            let mut next = || {
                let path = paths.next().unwrap();
                created.push(path.clone());
                path
            };
            // 1500 chains of four, 200 fan-outs of ten, four chains of 500.
            for _ in 0..1500 {
                let mut parent = insert_artifact(tx, &next(), None);
                for _ in 0..3 {
                    parent = insert_derived(tx, parent, &next());
                }
            }
            for _ in 0..200 {
                let source = insert_artifact(tx, &next(), None);
                for _ in 0..9 {
                    insert_derived(tx, source, &next());
                }
            }
            for _ in 0..4 {
                let mut parent = insert_artifact(tx, &next(), None);
                for _ in 0..499 {
                    parent = insert_derived(tx, parent, &next());
                }
            }
        });
        for path in &created {
            fs::write(path, b"x").unwrap();
        }
        assert_eq!(created.len(), 10_000);
        let started = std::time::Instant::now();
        let first = components_at(&f.db, &f.folder, 0).unwrap();
        let built = started.elapsed();
        let started = std::time::Instant::now();
        let again = components_at(&f.db, &f.folder, 0).unwrap();
        let cached = started.elapsed();
        let started = std::time::Instant::now();
        let members = members_at(&f.db, &f.folder, &first.token, 0).unwrap();
        let member_page = started.elapsed();
        println!(
            "folder index: 10000 artifacts, {} components; build {built:?}, cached {cached:?}, member page {member_page:?}",
            first.total
        );
        assert_eq!(again.token, first.token);
        assert_eq!(first.total, 1500 + 200 + 4);
        assert_eq!(members.total, 10_000);
        assert!(
            built < Duration::from_secs(20),
            "index build took {built:?}"
        );
    }
}
