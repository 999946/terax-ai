# Plugin system

## Purpose

Terax plugins are user-level Node.js event handlers. A plugin is not owned by a Space and is not stored in a project directory. Plugins receive selected Terax lifecycle and file events and return structured results. They do not handle terminal events.

The built-in plugin is named `space-info`. It is an ordinary event handler plugin, not the name of the plugin system.

## Configuration model

The persisted plugin configuration is:

```ts
type Plugin = {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  schemaVersion: 1;
};
```

Terax owns the execution details:

- The runtime is Node.js.
- Users edit only the Node script content in Settings.
- The script is stored at:

  ```text
  {data}/terax/plugins/{pluginId}.mjs
  ```

- Terax creates and owns the entry path.
- Users do not configure a Node path, entry path, manifest, or process arguments.
- Plugin configuration is stored at:

  ```text
  {data}/terax/plugins.json
  ```

The Rust process owns configuration persistence, Node execution, and entry file IO. The webview never reads or writes these files directly.

## Plugin source format

A plugin exports a default object whose keys are event names and whose values are asynchronous handlers:

```js
function toSpaceInfo(space) {
  return {
    summary: space.name,
    status: "unknown",
    onlineAt: null,
    lastTestedAt: null,
  };
}

export default {
  "spaces.loaded": async ({ spaces }) => ({
    type: "spaces.info.updated",
    spaces: Object.fromEntries(
      spaces.map((space) => [space.id, toSpaceInfo(space)]),
    ),
  }),

  "space.activated": async ({ space }) => ({
    type: "space.info.updated",
    spaceId: space.id,
    info: toSpaceInfo(space),
  }),
};
```

Users do not write JSONL, JSON-RPC, stdin/stdout framing, startup code, or process management. Terax loads the default export, selects the handler matching the event, invokes it, validates the result, and isolates failures.

## Events and TypeScript contracts

The supported event names are:

```ts
type PluginEventType =
  | "app.started"
  | "spaces.loaded"
  | "spaces.changed"
  | "space.activated"
  | "space.deactivated"
  | "file.saved";
```

Every event has a versioned context:

```ts
type PluginEventContext = {
  eventId: string;
  eventType: PluginEventType;
  eventVersion: 1;
  emittedAt: string;
};
```

Event payloads are defined in `src/modules/plugin/events.ts` and include:

- `spaces.loaded`: the complete list of Space contexts.
- `spaces.changed`: the current list and added, removed, and updated IDs.
- `space.activated`: the active Space and previous Space ID.
- `space.deactivated`: the inactive Space and next Space ID.
- `file.saved`: Space context, file metadata, and save source.

A Space context contains only `id`, `name`, and `root`. File events contain metadata such as path, language, byte length, and whether the file is new. File contents, credentials, control tokens, and process identifiers are not passed by default.

Handler results are structured values:

```ts
type PluginEventResult =
  | { type: "handled" }
  | {
      type: "space.info.updated";
      spaceId: string;
      info: SpaceInfo;
    }
  | {
      type: "spaces.info.updated";
      spaces: Record<string, SpaceInfo>;
    };
```

`SpaceInfo` contains `summary`, `status`, `onlineAt`, and `lastTestedAt`. Remote timestamps must come from the remote system. Terax must not derive them from process start, file modification time, refresh time, or Space activity.

## Built-in plugin

`space-info` is seeded into `plugins.json` and its content is always replaced with the current built-in event-handler source when the configuration is loaded. The built-in handlers cover application start, Spaces loading and changes, Space activation and deactivation, and file saves.

The built-in plugin does not invent remote business data. It returns the Space name as the summary, `unknown` status, and null timestamps.

## Settings interaction

The Plugins settings page is a list by default. Each row shows the plugin name, edit action, delete action, and enabled switch.

Clicking Edit expands the form in that row. The form edits the plugin name and Node script content. At most one row is expanded at a time.

If the current form has unsaved changes and the user selects another row or Add plugin, Terax asks what to do:

- Save and switch
- Discard changes
- Cancel

Cancel closes the current form without writing changes. Save validates the name, persists the configuration, and writes the managed entry file. Only one plugin can be enabled at a time. Enabling one plugin disables the others atomically.

## Internal execution

The JSONL transport is an internal implementation detail between Rust and a managed Node invocation wrapper. It is not part of the user-facing plugin API. The wrapper loads the user's default export, invokes the matching event handler, and returns the handler result or a structured error to Rust.

An event without a corresponding handler is treated as handled with no result. A handler exception, invalid result, timeout, or process failure is reported as a plugin error. Non-blocking event failures do not block Space switching, file saving, tab creation, or terminal startup.

## Event lifecycle

Terax dispatches events at these points:

1. After the application and Spaces finish loading, it dispatches `app.started` and `spaces.loaded`.
2. When the Space collection changes, it dispatches `spaces.changed`.
3. When the active Space changes, it dispatches `space.deactivated` followed by `space.activated`.
4. After a file is successfully saved, it dispatches `file.saved`.

The event dispatcher is asynchronous. Space UI updates consume `space.info.updated` and `spaces.info.updated` results. Failed or slow plugins do not hold up the originating Terax action.

## Rust boundary and security

Rust is the only process, filesystem, and OS boundary. It must:

- Spawn Node with structured executable and arguments, never a shell command string.
- Create the managed plugin directory and entry file.
- Validate plugin identifiers before using them in paths.
- Restrict entry reads and writes to the managed entry file.
- Bound JSON line size, response size, stderr storage, and handler timeouts.
- Detect process exit and clean up child processes.
- Avoid passing credentials, control tokens, or process identifiers to plugins.

Plugins are explicitly user-run local code. Terax does not claim to provide an OS sandbox. Users should only enable scripts they trust.

## Testing requirements

Changes to the plugin system should cover:

- Latest configuration loading, persistence, built-in replacement, duplicate identifiers, and single-enabled-plugin behavior.
- Managed entry path generation and read/write behavior.
- Event envelope validation, handler selection, invalid results, timeouts, and child-process cleanup.
- Built-in event-handler smoke tests for `spaces.loaded` and `space.activated`.
- Frontend list, edit, save, cancel, delete, enable, unsaved-change confirmation, dispatch, and result handling.

Run the frontend checks from the project directory:

```bash
pnpm check-types
pnpm test --run
```

Run Rust checks from `src-tauri`:

```bash
cargo check
cargo test --lib
```
