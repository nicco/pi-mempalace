import test from "node:test";
import assert from "node:assert/strict";
import { HttpTransport } from "../src/mcp-transport.ts";

test("HttpTransport rejects connect when server is unreachable", async () => {
  const transport = new HttpTransport("http://localhost:1/mcp", 500);
  await assert.rejects(
    transport.connect(),
    /timed out|ECONNREFUSED|connection|fetch.*failed|Failed to parse URL|Invalid URL|abort/i,
  );
});

test("HttpTransport getTools returns empty before connect", () => {
  const transport = new HttpTransport("http://localhost:9999/mcp");
  assert.deepEqual(transport.getTools(), []);
  assert.equal(transport.isConnected, false);
  assert.equal(transport.getCommandLine(), "http://localhost:9999/mcp");
  assert.equal(transport.getStderr(), "");
});

test("HttpTransport getType returns 'http'", () => {
  const transport = new HttpTransport("http://localhost:9999/mcp");
  assert.equal(transport.getType(), "http");
});

test("HttpTransport closes cleanly without connecting", async () => {
  const transport = new HttpTransport("http://localhost:9999/mcp");
  await transport.close();
  assert.equal(transport.isConnected, false);
});
