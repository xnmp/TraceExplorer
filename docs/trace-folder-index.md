# Folder grouping and reference payloads

The folder index displays current files, unsaved folder outputs, active
placeholders and their direct parents. It does not recursively import ancestors.
An image in a subfolder or outside the folder is a reference badge when it has
no parent **in that displayed graph**, even if it has recorded ancestors elsewhere
or its file is missing. Unsaved folder outputs are classified as current.

Grouping ignores edges from these references. Each reference is attached once
to every component it directly feeds. Other edges still join components:
an outside image with a displayed parent is an ordinary member, and edits using
two current lineages still merge them. Classification happens before grouping,
so it cannot change depending on which component is read first.

For compatibility, `trace_component_nodes` still includes the reference node
and consumers' parent keys in every component. The current section view draws
it as an outside parent. Only the reference copy carries optional metadata:

```json
{
  "key": "a:17",
  "artifactId": 17,
  "path": "/pictures/refs/style.png",
  "scope": "subfolder",
  "parents": [],
  "referenceBadge": {
    "key": "a:17",
    "path": "/pictures/refs/style.png",
    "scope": "subfolder",
    "artifactId": 17,
    "consumers": ["o:21:0", "o:23:0"]
  }
}
```

Other existing node fields are omitted from this example. `artifactId` supplies
recorded revision identity instead of a digest; `key` supplies stable graph and
selection identity. Paths in the folder tree, including nested badge paths,
follow the requested folder spelling (such as a symlink).

The metadata matches sibling `gflow` commit
`cab20e9d7ed895b46de4003f99dd88c6e98e21b2`'s `ReferenceBadge`
(`key`, `path`, `scope`, `consumers`), with `artifactId` added. It is carried on
node pages rather than summaries, keeping component discovery lightweight.
Consumers are deduplicated, sorted by creation order then key, and restricted
to this component. Projecting a whole folder in the sibling transform instead
collects consumers across every supplied lineage. Read **all** component node
pages before using consumers or calling
`projectReferenceBadges(projectDag(nodes))`: a consumer may be on a later page.

For healthy DAGs the sibling transform derives the same badges from these
complete nodes. One existing malformed-history difference remains: native
grouping uses displayed edges before cycle sanitizing, whereas the sibling
transform uses `projectDag`'s accepted edges. An outside image with a self-parent
therefore remains an ordinary native member but may be classified as a badge
by the sibling transform after that edge is removed. `referenceBadge` records
the native decision; a future consumer requiring exact native classification
should use this metadata. Both native and mock tests cover that case.

`nodeCount` and node-page totals include each component's reference copies.
`imageCount` retains its existing rule: present current-scope nodes excluding
earlier revisions; references never count. Folder members contain only present
direct-folder seeds, with unique file ownership, and exclude badge copies and
unsaved outputs. Component pages count stacks rather than references. All pages
keep their existing item limits and byte budget; continue from
`offset + items.length` until `total` is reached.

Component IDs use the oldest **non-badge** identity (sources before outputs,
numeric IDs). Sharing a badge cannot give separate stacks the same ID. A merge,
split or removal of that oldest member can change an ID; some surviving pieces
may keep it. Resolve node keys or paths against each refreshed index. Preview
and extra picks prefer their issuing component when multiple copies exist,
then search fresh replacements before declaring the node gone.

`tests/fixtures/folder-grouping.json` is the shared native/mock golden contract.
The browser harness additionally exposes `?grouping=two-chains`,
`?grouping=style-many` and `?grouping=external-cover` for the legacy section view.
