function toSpaceInfo(space) {
  // Surface the workspace scope as the subtitle so the default plugin's output
  // is visible (and distinct from the space name already shown as the title).
  const env = space?.env;
  const isWsl = env?.kind === "wsl";
  return {
    summary: isWsl ? `WSL · ${env.distro}` : "Local",
    status: isWsl ? "unknown" : "online",
    onlineAt: null,
    lastTestedAt: null,
  };
}

export default {
  "spaces.loaded": async ({ spaces }) => ({
    type: "spaces.info.updated",
    spaces: Object.fromEntries(
      (Array.isArray(spaces) ? spaces : [])
        .filter((space) => space && typeof space.id === "string")
        .map((space) => [space.id, toSpaceInfo(space)]),
    ),
  }),

  "space.activated": async ({ space }) => ({
    type: "space.info.updated",
    spaceId: space.id,
    info: toSpaceInfo(space),
  }),};
