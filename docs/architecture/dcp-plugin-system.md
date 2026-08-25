# Plugin system

## Purpose

Terax plugins are user-level programs that provide external project and Space information. A plugin is not owned by a Space and is not stored in a project directory. One enabled plugin serves every Space.

The first built-in plugin is named DCP. DCP is a plugin name, not the name of the plugin storage system or its directory.

## Configuration model

The persisted plugin configuration is:

```ts
type PluginConfig = {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  schemaVersion: number;
};
```

Terax owns the execution details:

- The executable is Node.js. Users do not configure a node path.
- Terax creates and owns each plugin entry file.
- Entry files are stored below the application data directory:

  ```text
  {data}/terax/plugins/{pluginId}.mjs
  ```

- The script content is editable from Settings.
- Node path, entry path, and arbitrary process arguments are not user-facing fields.
- Saving a plugin writes its content to the managed entry file before the next run.

The Rust process is the owner of configuration persistence and entry file IO. The webview never reads or writes these files directly.

## Built-in plugin

The built-in plugin has a stable identifier and is seeded into the user configuration when absent. Existing user plugins are preserved. The built-in script is a normal Node plugin and can be inspected and edited in Settings.

The built-in plugin does not invent remote business data. When no remote source is connected it returns `unknown` status and null time fields.

## Settings interaction

The Plugins settings page is a list by default. Each row shows the plugin name, edit action, delete action, and enabled switch.

Clicking Edit expands the form in that row. The form edits the plugin name and Node script content. At most one row is expanded at a time.

If the current form has unsaved changes and the user selects another row or Add plugin, Terax asks what to do:

- Save and switch
- Discard changes
- Cancel

Cancel closes the current form without writing changes. Save validates the name, persists the configuration, writes the managed entry file, and refreshes the runtime. Delete removes the configuration but does not delete arbitrary user files.

Only one plugin can be enabled at a time. Enabling one plugin disables the others atomically.

## Plugin protocol

Communication uses newline-delimited JSON-RPC over the Node process standard input and standard output. Each request and response is one JSON object per line. Stderr is diagnostic output and is bounded by the Rust supervisor.

The initial method is `get_snapshot`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "get_snapshot",
  "params": {
    "spaces": [
      {"id": "space-1", "name": "API", "root": "/work/api"}
    ]
  }
}
```

A response contains a snapshot for each requested Space:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "spaces": {
      "space-1": {
        "summary": "API service",
        "status": "online",
        "onlineAt": "2026-08-25T10:00:00Z",
        "lastTestedAt": "2026-08-25T10:30:00Z"
      }
    }
  }
}
```

Implementations may use an equivalent result shape supported by the current protocol adapter, but the semantic fields are fixed:

- `summary`: remote project or service summary.
- `status`: `online`, `offline`, `degraded`, or `unknown`.
- `onlineAt`: remote business timestamp, or null when unavailable.
- `lastTestedAt`: remote test-system timestamp, or null when unavailable.

Terax must display remote timestamps as returned. It must not derive them from local process start, file mtime, refresh time, or Space activity.

## Refresh lifecycle

After Spaces finish loading, Terax sends one batch request for all Spaces. When the active Space changes, Terax sends an asynchronous request for that Space. Refresh failures do not block switching Spaces, creating tabs, or starting terminals.

Enabling, disabling, editing, saving script content, or restarting a plugin replaces the old runtime and triggers a new batch refresh. Old responses must not overwrite newer responses after a restart or rapid Space switch.

Local connection state is separate from remote status:

- `unconfigured`
- `starting`
- `loading`
- `ready`
- `unavailable`

A plugin failure leaves the last valid snapshot visible when possible and reports the failure through the DCP status or error channel.

## Rust boundary and security

Rust is the only process, filesystem, and OS boundary. The supervisor must:

- Spawn Node with structured executable and arguments, never a shell command string.
- Create the managed plugin directory and entry file.
- Validate plugin identifiers before using them in paths.
- Restrict entry reads and writes to the configured managed entry file.
- Bound JSON line size, response size, stderr storage, and request timeouts.
- Validate JSON-RPC version, request identifier, response shape, and snapshot status values.
- Detect process exit and clean up the child on restart and application exit.
- Avoid passing credentials, control tokens, or process identifiers to plugins.

Plugins are explicitly user-run local code. Terax does not claim to provide an OS sandbox. Users should only enable scripts they trust.

## Compatibility and migration

Older configurations may contain `command`, `nodePath`, `entryPath`, or `args`. Migration reads the old entry content when possible and writes the result into the managed plugin file. Missing or unreadable old content is replaced by a minimal valid script that returns unknown snapshots. The migrated configuration is saved in the current schema.

## Testing requirements

Changes to the plugin system should cover:

- Configuration loading, persistence, migration, duplicate identifiers, and single-enabled-plugin behavior.
- Managed entry path generation and read/write behavior.
- JSONL framing, invalid JSON, request identifiers, response limits, timeouts, and child-process cleanup.
- Built-in plugin smoke tests for `get_snapshot` and unknown timestamp behavior.
- Frontend list, edit, save, cancel, delete, enable, unsaved-change confirmation, and stale-response handling.

Run the frontend checks from the project directory:

```bash
pnpm lint
pnpm check-types
pnpm test --run
```

Run Rust checks from `src-tauri`:

```bash
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```
