/**
 * Integration tests for MCPHypervisor SSE transport handling.
 *
 * The bug being verified:
 *   SSEClientTransport uses an EventSource which auto-reconnects when the
 *   server drops the SSE stream. On reconnect, the new `endpoint` event
 *   silently updates transport._endpoint to a new session URL. The MCP
 *   Client still thinks it is connected, so subsequent tool calls hit a
 *   fresh, uninitialized session on the server and get rejected with
 *   "Received request before initialization was complete".
 *
 * These tests run a real http.Server with the SDK's SSEServerTransport, then
 * connect to it through the real MCPHypervisor (which uses the SDK's Client
 * and SSEClientTransport). They exercise the actual handler-chaining inside
 * Client.connect / Protocol.connect, so a regression in any of those layers
 * would be caught. The tests also include a regression check that fails if
 * the onerror→close→cleanup fix is removed.
 */

const http = require("node:http");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  SSEServerTransport,
} = require("@modelcontextprotocol/sdk/server/sse.js");
const {
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const MCPHypervisor = require("../../../utils/MCP/hypervisor");

// ----- Test SSE server fixture -----

class TestMcpServer {
  constructor() {
    this.activeTransports = new Map(); // sessionId -> SSEServerTransport
    this.sessionsInitialized = new Set();
    this.listToolsCallCount = 0;
  }

  async start() {
    this.httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/sse") {
        const sdkServer = new Server(
          { name: "test-mcp", version: "0.1.0" },
          { capabilities: { tools: {} } }
        );
        sdkServer.setRequestHandler(ListToolsRequestSchema, async () => {
          this.listToolsCallCount++;
          return { tools: [{ name: "noop", description: "noop", inputSchema: { type: "object" } }] };
        });

        const transport = new SSEServerTransport("/messages", res);
        // Track the session as soon as it sends its endpoint event.
        const originalStart = transport.start.bind(transport);
        transport.start = async () => {
          await originalStart();
          this.activeTransports.set(transport.sessionId, transport);
        };
        await sdkServer.connect(transport);
        // sdkServer.connect calls transport.start() which writes the endpoint event.
      } else if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId");
        const transport = this.activeTransports.get(sessionId);
        if (!transport) {
          res.writeHead(404).end("Unknown session");
          return;
        }
        await transport.handlePostMessage(req, res);
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise((resolve) => this.httpServer.listen(0, resolve));
    const { port } = this.httpServer.address();
    this.url = `http://127.0.0.1:${port}/sse`;
  }

  // Forcibly drop every active SSE stream — simulates the server crashing,
  // restarting, or timing the client out. The client's EventSource will react
  // by firing onerror (and, without the fix, silently auto-reconnecting).
  killAllSseConnections() {
    for (const [sessionId, transport] of this.activeTransports) {
      try {
        transport.res?.destroy();
      } catch {
        /* ignore */
      }
      this.activeTransports.delete(sessionId);
      this.sessionsInitialized.delete(sessionId);
    }
  }

  async stop() {
    this.killAllSseConnections();
    await new Promise((resolve) => this.httpServer.close(resolve));
  }
}

// Poll a predicate up to `timeoutMs`; resolves when true, rejects on timeout.
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ----- Tests -----

describe("MCPHypervisor SSE transport handling (real server)", () => {
  let testServer;
  let hypervisor;

  beforeEach(async () => {
    testServer = new TestMcpServer();
    await testServer.start();

    MCPHypervisor._instance = null;
    hypervisor = new MCPHypervisor();
    jest.spyOn(hypervisor, "log").mockImplementation(() => {});

    // Point the hypervisor at our test server via the config getter.
    jest
      .spyOn(hypervisor, "mcpServerConfigs", "get")
      .mockReturnValue([
        {
          name: "test-server",
          server: { type: "sse", url: testServer.url },
        },
      ]);
  });

  afterEach(async () => {
    // Best-effort cleanup of any still-connected mcps the hypervisor is holding.
    for (const name of Object.keys(hypervisor.mcps)) {
      try {
        await hypervisor.mcps[name].close();
      } catch {
        /* ignore */
      }
    }
    MCPHypervisor._instance = null;
    await testServer.stop();
    jest.restoreAllMocks();
  });

  it("happy path: boots the server and listTools works through real SSE", async () => {
    await hypervisor.bootMCPServers();

    expect(hypervisor.mcps["test-server"]).toBeDefined();
    expect(hypervisor.mcpLoadingResults["test-server"].status).toBe("success");

    const result = await hypervisor.mcps["test-server"].listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("noop");
    expect(testServer.listToolsCallCount).toBe(1);
  });

  it("clears this.mcps[name] when the server drops the SSE connection", async () => {
    await hypervisor.bootMCPServers();
    expect(hypervisor.mcps["test-server"]).toBeDefined();

    // Server-side disconnect — the client EventSource will fire onerror.
    testServer.killAllSseConnections();

    // The fix wires onerror → transport.close() → onclose → delete mcps[name].
    // Without that chain, mcps["test-server"] would stay populated because
    // EventSource would silently auto-reconnect without re-initialization.
    await waitFor(() => hypervisor.mcps["test-server"] === undefined);

    expect(hypervisor.mcps["test-server"]).toBeUndefined();
    expect(hypervisor.mcpLoadingResults["test-server"].status).toBe("failed");
  });

  it("does not leave a stale, never-initialized session reachable via mcps", async () => {
    // This is the regression check that maps directly to the original bug:
    // after a server-side drop, the next attempt to use the cached mcp must
    // NOT silently succeed against a fresh, uninitialized session.
    await hypervisor.bootMCPServers();
    const staleMcp = hypervisor.mcps["test-server"];
    expect(staleMcp).toBeDefined();

    testServer.killAllSseConnections();
    await waitFor(() => hypervisor.mcps["test-server"] === undefined);

    // The hypervisor's lookup map no longer exposes the stale client. This is
    // what the call sites (convertServerToolsToPlugins, _resolveMcpVariable)
    // check before invoking tools, so an agent call right now would correctly
    // return null instead of POSTing tools/list to a fresh, uninitialized
    // session on the server.
    expect(hypervisor.mcps["test-server"]).toBeUndefined();

    // Calling listTools directly on the stale reference should also fail —
    // Protocol._onclose runs as part of our cleanup chain and sets the
    // client's _transport to undefined, so the request gets rejected.
    await expect(staleMcp.listTools()).rejects.toThrow();
  });

  it("re-initializes successfully after a dropped connection", async () => {
    await hypervisor.bootMCPServers();
    expect(hypervisor.mcps["test-server"]).toBeDefined();

    testServer.killAllSseConnections();
    await waitFor(() => hypervisor.mcps["test-server"] === undefined);

    // Next boot call must rebuild — the empty mcps map allows it through the
    // early-return guard, and the full initialize handshake must complete.
    await hypervisor.bootMCPServers();
    expect(hypervisor.mcps["test-server"]).toBeDefined();
    expect(hypervisor.mcpLoadingResults["test-server"].status).toBe("success");

    // And the rebuilt connection actually works end-to-end against the server.
    const result = await hypervisor.mcps["test-server"].listTools();
    expect(result.tools).toHaveLength(1);
    expect(testServer.listToolsCallCount).toBe(1);
  });
});
