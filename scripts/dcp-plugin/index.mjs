#!/usr/bin/env node
// Built-in DCP plugin. It reports only data supplied by a remote integration.
// The plugin does not invent status, onlineAt, or lastTestedAt values.
import readline from "node:readline";

function snapshot(spaces) {
  const result = {};
  for (const space of Array.isArray(spaces) ? spaces : []) {
    if (!space || typeof space.id !== "string") continue;
    result[space.id] = {
      summary: typeof space.name === "string" ? space.name : "",
      status: "unknown",
      onlineAt: null,
      lastTestedAt: null,
    };
  }
  return result;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method !== "get_snapshot") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: { code: -32601, message: "Method not found" },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id ?? null,
    result: { spaces: snapshot(request.params?.spaces) },
  })}\n`);
});