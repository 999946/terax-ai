/**
 * "Jump to Source" from a diff viewer: the reviewer wants the file in a real
 * editor tab, at the changed line. The viewer knows the path and line but not
 * the tab store, so it dispatches a window event `App` handles — the same
 * decoupling the AI panel uses for attachments.
 */
export const JUMP_TO_SOURCE_EVENT = "terax:jump-to-source";

export type JumpToSourceDetail = { path: string; line?: number };

export function requestJumpToSource(detail: JumpToSourceDetail): void {
  window.dispatchEvent(
    new CustomEvent<JumpToSourceDetail>(JUMP_TO_SOURCE_EVENT, { detail }),
  );
}
