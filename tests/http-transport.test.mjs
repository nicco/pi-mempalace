import test from "node:test";
import assert from "node:assert/strict";
import { HttpTransport } from "../src/mcp-transport.ts";
import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// Error-path tests (original)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock MCP server helpers for happy-path tests
// ---------------------------------------------------------------------------

/**
 * Creates a mock MCP Streamable HTTP server that responds to initialize,
 * tools/list, and tools/call requests with realistic MCP protocol behavior.
 */
function createMockMcpsServer(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        const receivedSessionId = req.headers["mcp-session-id"];
        const parsed = JSON.parse(body);

        if (parsed.method === "initialize") {
          // First request — no session ID yet. Respond with session ID in header.
          const sessionId = `mock-session-${Date.now()}`;
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId,
          });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "mock-mcp", version: "1.0.0" },
            },
          }));
          // Store session ID for subsequent requests
          server._sessionId = sessionId;
          return;
        }

        // Subsequent requests require session ID
        if (!receivedSessionId || receivedSessionId !== server._sessionId) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32000, message: "Unauthorized: missing or invalid session ID" },
          }));
          return;
        }

        if (parsed.method === "notifications/initialized") {
          // Notifications get no response body
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("");
          return;
        }

        if (parsed.method === "tools/list") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": server._sessionId,
          });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              tools: [
                { name: "mempalace_search", description: "Search memories", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
                { name: "mempalace_filing", description: "File memories", inputSchema: { type: "object", properties: { content: { type: "string" } } } },
              ],
            },
          }));
          return;
        }

        if (parsed.method === "tools/call") {
          const toolName = parsed.params?.name;
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": server._sessionId,
          });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              content: [{ type: "text", text: `Result of ${toolName}` }],
            },
          }));
          return;
        }

        // Unknown method
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          error: { code: -32601, message: `Method not found: ${parsed.method}` },
        }));
      });
    });

    server.listen(port, () => {
      server._sessionId = null;
      resolve(server);
    });
  });
}

async function stopServer(server) {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Happy-path tests with mock MCP server
// ---------------------------------------------------------------------------

test("HttpTransport connects, discovers tools, and calls a tool", async () => {
  const server = await createMockMcpsServer(0); // OS assigns random port
  const address = server.address();
  const url = `http://localhost:${address.port}/mcp`;

  try {
    const transport = new HttpTransport(url, 3000);

    // Should not be connected before connect()
    assert.equal(transport.isConnected, false);
    assert.deepEqual(transport.getTools(), []);

    // Connect should succeed
    await transport.connect();

    // Should now be connected with discovered tools
    assert.equal(transport.isConnected, true);
    const tools = transport.getTools();
    assert.ok(tools.length >= 2, `Expected at least 2 tools, got ${tools.length}`);
    assert.ok(tools.some((t) => t.name === "mempalace_search"));
    assert.ok(tools.some((t) => t.name === "mempalace_filing"));

    // Calling a tool should work
    const result = await transport.callTool("mempalace_search", { query: "hello" });
    assert.deepEqual(result, { content: [{ type: "text", text: "Result of mempalace_search" }] });

    // Second call should reuse the session
    const result2 = await transport.callTool("mempalace_filing", { content: "test" });
    assert.deepEqual(result2, { content: [{ type: "text", text: "Result of mempalace_filing" }] });

    // Close should work
    await transport.close();
    assert.equal(transport.isConnected, false);
  } finally {
    await stopServer(server);
  }
});

test("HttpTransport reuses session across multiple requests", async () => {
  let requestCount = 0;
  const server = await createMockMcpsServer(0);
  const address = server.address();
  const url = `http://localhost:${address.port}/mcp`;

  try {
    const transport = new HttpTransport(url, 3000);
    await transport.connect();

    // Make multiple tool calls
    for (let i = 0; i < 5; i++) {
      const result = await transport.callTool("mempalace_search", { query: `query ${i}` });
      assert.ok(result);
      requestCount++;
    }

    // All should have succeeded on the same session
    assert.equal(requestCount, 5);
    assert.equal(transport.isConnected, true);

    await transport.close();
  } finally {
    await stopServer(server);
  }
});

test("HttpTransport callTool auto-connects when not connected", async () => {
  const server = await createMockMcpsServer(0);
  const address = server.address();
  const url = `http://localhost:${address.port}/mcp`;

  try {
    const transport = new HttpTransport(url, 3000);
    assert.equal(transport.isConnected, false);

    // callTool should auto-connect
    const result = await transport.callTool("mempalace_search", { query: "auto" });
    assert.ok(result);
    assert.equal(transport.isConnected, true);

    await transport.close();
  } finally {
    await stopServer(server);
  }
});

test("HttpTransport listTools auto-connects when not connected", async () => {
  const server = await createMockMcpsServer(0);
  const address = server.address();
  const url = `http://localhost:${address.port}/mcp`;

  try {
    const transport = new HttpTransport(url, 3000);
    assert.equal(transport.isConnected, false);

    const tools = await transport.listTools();
    assert.ok(tools.length >= 2);
    assert.equal(transport.isConnected, true);

    await transport.close();
  } finally {
    await stopServer(server);
  }
});

test("HttpTransport auto-reconnects after close", async () => {
  const server = await createMockMcpsServer(0);
  const address = server.address();
  const url = `http://localhost:${address.port}/mcp`;

  try {
    const transport = new HttpTransport(url, 3000);
    await transport.connect();
    assert.equal(transport.isConnected, true);

    await transport.close();
    assert.equal(transport.isConnected, false);

    // callTool auto-connects, so it should succeed after close (reconnects)
    const result = await transport.callTool("mempalace_search", { query: "reconnect" });
    assert.ok(result);
    assert.equal(transport.isConnected, true);

    await transport.close();
  } finally {
    await stopServer(server);
  }
});

test("HttpTransport handles server returning Mcp-Session-Id on non-initialize requests", async () => {
  const server = await createMockMcpsServer(0);
  const address = server.address();
  const url = `http://localhost:${address.port}/mcp`;

  try {
    const transport = new HttpTransport(url, 3000);
    await transport.connect();
    const initialSession = transport["sessionId"]; // Access private field via bracket notation
    assert.ok(initialSession);

    // Make a tool call — server returns the same session ID in headers
    // The transport should update its sessionId if it changed
    const result = await transport.callTool("mempalace_search", { query: "rotate" });
    assert.ok(result);

    await transport.close();
  } finally {
    await stopServer(server);
  }
});

test("HttpTransport getType returns 'http' after connect", async () => {
  const server = await createMockMcpsServer(0);
  const address = server.address();
  const url = `http://localhost:${address.port}/mcp`;

  try {
    const transport = new HttpTransport(url, 3000);
    assert.equal(transport.getType(), "http");
    await transport.connect();
    assert.equal(transport.getType(), "http");
    await transport.close();
    assert.equal(transport.getType(), "http");
  } finally {
    await stopServer(server);
  }
});

test("HttpTransport getCommandLine returns the URL", async () => {
  const server = await createMockMcpsServer(0);
  const address = server.address();
  const url = `http://localhost:${address.port}/mcp`;

  try {
    const transport = new HttpTransport(url, 3000);
    assert.equal(transport.getCommandLine(), url);
    await transport.connect();
    assert.equal(transport.getCommandLine(), url);
    await transport.close();
    assert.equal(transport.getCommandLine(), url);
  } finally {
    await stopServer(server);
  }
});

test("HttpTransport getStderr returns empty string", async () => {
  const server = await createMockMcpsServer(0);
  const address = server.address();
  const url = `http://localhost:${address.port}/mcp`;

  try {
    const transport = new HttpTransport(url, 3000);
    assert.equal(transport.getStderr(), "");
    await transport.connect();
    assert.equal(transport.getStderr(), "");
    await transport.close();
    assert.equal(transport.getStderr(), "");
  } finally {
    await stopServer(server);
  }
});


