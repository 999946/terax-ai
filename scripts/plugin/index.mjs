function toSpaceInfo(space) {
  return {
    summary: typeof space?.name === "string" ? space.name : "",
    status: "unknown",
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
