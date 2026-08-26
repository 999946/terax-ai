# Terax Plugin Event Handlers

## Overview

Terax plugins are user-level Node.js programs that handle selected Terax events.

A plugin is not a Space, does not belong to a Space, and is not defined as a background service. Terax decides when a plugin handler runs. The plugin author writes the event-specific business logic.

The first built-in plugin is `space-info`. It demonstrates how a plugin can turn Space lifecycle events into structured Space information for the UI.

## What plugin authors write

A plugin is a Node.js module with a default export. The default export is an object whose keys are supported event names and whose values are asynchronous handlers.

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

A handler can be omitted when a plugin does not need an event. Terax does not call missing handlers.

Plugin authors do not write:

- `manifest.json`
- JSON-RPC
- JSONL framing
- stdin/stdout readers
- process startup code
- process shutdown code
- terminal event handlers

Those are runtime concerns owned by Terax.

## Supported events

The first event set is intentionally small and tied to real Terax lifecycle points:

| Event | When Terax emits it | Typical use |
| --- | --- | --- |
| `app.started` | Application initialization is complete | Initialize plugin state |
| `spaces.loaded` | The complete Space list is available | Batch-load external Space information |
| `spaces.changed` | Spaces were added, removed, or updated | Reconcile external data |
| `space.activated` | A Space became active | Refresh the active Space |
| `space.deactivated` | A Space stopped being active | Release temporary state or keep the last snapshot |
| `file.saved` | A file was successfully saved | Run post-save processing |

Terminal events are intentionally outside this plugin contract.

## TypeScript contracts

The canonical frontend definitions live in:

```text
src/modules/plugin/events.ts
```

The common event context is:

```ts
export type PluginEventContext = {
  eventId: string;
  eventType: PluginEventType;
  eventVersion: 1;
  emittedAt: string;
};
```

Space data is deliberately limited:

```ts
export type SpaceContext = {
  id: string;
  name: string;
  root: string;
};
```

File events carry metadata rather than file contents:

```ts
export type FileContext = {
  path: string;
  language: string | null;
  byteLength: number | null;
  isNew: boolean;
};
```

The event-specific input shapes are:

```ts
export type AppStartedInput = {
  context: PluginEventContext;
};

export type SpacesLoadedInput = {
  spaces: SpaceContext[];
  context: PluginEventContext;
};

export type SpacesChangedInput = {
  spaces: SpaceContext[];
  added: string[];
  removed: string[];
  updated: string[];
  context: PluginEventContext;
};

export type SpaceActivatedInput = {
  space: SpaceContext;
  previousSpaceId: string | null;
  context: PluginEventContext;
};

export type SpaceDeactivatedInput = {
  space: SpaceContext;
  nextSpaceId: string | null;
  context: PluginEventContext;
};

export type FileSavedInput = {
  space: SpaceContext;
  file: FileContext;
  source: "editor" | "external" | "unknown";
  context: PluginEventContext;
};
```

Plugins do not receive credentials, control tokens, process IDs, or file contents by default.

## Handler results

Handlers return a small, structured result union:

```ts
export type PluginEventResult =
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

Space information is defined as:

```ts
export type SpaceInfo = {
  summary: string;
  status: "online" | "offline" | "degraded" | "unknown";
  onlineAt: string | null;
  lastTestedAt: string | null;
};
```

`onlineAt` and `lastTestedAt` are remote business timestamps. Terax must display them as returned by the plugin and must never infer them from local process time, file modification time, refresh time, or Space activity.

The built-in `space-info` plugin therefore returns:

```js
{
  summary: space.name,
  status: "unknown",
  onlineAt: null,
  lastTestedAt: null,
}
```

## Runtime behavior

The Rust side is the plugin boundary. For each event it:

1. Selects the enabled plugin.
2. Writes the configured Node source to the managed entry file.
3. Loads the module's default export.
4. Looks up the handler by event name.
5. Calls the handler with the typed event payload.
6. Validates the returned result.
7. Sends the result to the relevant Terax store or UI.

JSONL may be used internally between Rust and a managed Node wrapper. That transport is not part of the authoring API and may change without requiring plugin source changes.

A missing handler returns no business result. A thrown error, invalid result, timeout, malformed module, or crashed process is reported as a plugin failure.

Plugin failures are isolated. They must not block:

- Space activation or deactivation
- Space list rendering
- Tab creation
- File saving
- Terminal startup

## Event lifecycle

The intended dispatch sequence is:

```text
Application ready
  -> app.started
  -> spaces.loaded

Space changes
  -> spaces.changed

Active Space changes
  -> space.deactivated(previous)
  -> space.activated(next)

File successfully saved
  -> file.saved
```

`spaces.loaded` is the batch entry point for the built-in plugin. `space.activated` refreshes the active Space asynchronously. `space.deactivated` does not require a new remote request; a plugin may use it to clean up temporary state.

## Configuration and storage

Plugin configuration is stored at:

```text
{data}/terax/plugins.json
```

The configuration shape is:

```ts
export type Plugin = {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  schemaVersion: 1;
};
```

Each source file is managed by Terax at:

```text
{data}/terax/plugins/{pluginId}.mjs
```

Users can maintain multiple plugins, but only one plugin is enabled at a time. Enabling one plugin disables the others atomically. Plugins never bind to individual Spaces.

## Settings behavior

The Plugins settings page starts as a list. Each row provides:

- Plugin name
- Edit
- Delete
- Enable or disable

Edit expands the selected row inline and exposes only:

- Name
- Node script
- Save
- Cancel

Only one row can be expanded at a time. If an edit is dirty and the user selects another row or starts Add plugin, Terax offers:

- Save and switch
- Discard changes
- Cancel

## Security boundary

Plugins are user-run local Node.js code and are not OS-sandboxed by Terax. Users should only enable code they trust.

Terax still protects its own boundary:

- Node is started without shell command concatenation.
- The entry path is derived from the validated plugin ID.
- The webview cannot directly read or write plugin files.
- Credentials and control tokens are not passed to plugins.
- Event payloads contain only the fields defined by the event contract.
- Handler output is validated before it updates Terax state.

## Testing expectations

Plugin changes should test:

- Event input and output TypeScript contracts.
- Default export loading and handler selection.
- Missing handlers and thrown handler errors.
- Invalid results, timeouts, and process exits.
- `spaces.loaded` batch results.
- `space.activated` single-Space results.
- Built-in `space-info` default source.
- Single-enabled-plugin behavior.
- Settings editing, saving, cancellation, and dirty-switch protection.
