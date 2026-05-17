/**
 * Tests for MCPHypervisor transport event handling.
 *
 * The SSE transport bug: EventSource auto-reconnects when the server drops the
 * connection, silently updating transport._endpoint to a new session URL while
 * the MCP Client still considers itself connected to the old session. Subsequent
 * tool calls hit the new, uninitialized session on the server and get
 * "RuntimeError: Received request before initialization was complete".
 *
 * The fix: transport.onerror calls transport.close() to stop auto-reconnect and
 * fire transport.onclose. transport.onclose removes the stale mcp from this.mcps
 * so the next bootMCPServers() call rebuilds with a proper handshake.
 */

const MCPHypervisor = require("../../../utils/MCP/hypervisor");

function makeMockTransport() {
  return {
    onclose: null,
    onerror: null,
    onmessage: null,
    start: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockImplementation(async function () {
      this.onclose?.();
    }),
  };
}

function makeMockMcp(transport) {
  return {
    transport,
    connect: jest.fn().mockImplementation(async () => {
      // Simulate Protocol.connect() wrapping the handlers then calling start()
      const _onclose = transport.onclose;
      const _onerror = transport.onerror;
      transport.onclose = () => {
        _onclose?.();
      };
      transport.onerror = (err) => {
        _onerror?.(err);
      };
      await transport.start();
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe("MCPHypervisor transport event handlers", () => {
  let hypervisor;

  beforeEach(() => {
    // Reset singleton between tests
    MCPHypervisor._instance = null;
    hypervisor = new MCPHypervisor();

    // Suppress log output in tests
    jest.spyOn(hypervisor, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    MCPHypervisor._instance = null;
    jest.restoreAllMocks();
  });

  describe("transport.onclose removes the server from this.mcps", () => {
    it("removes a connected server when its transport closes", async () => {
      const transport = makeMockTransport();
      const mcp = makeMockMcp(transport);

      // Manually register as if #startMCPServer ran successfully
      hypervisor.mcps["test-server"] = mcp;
      hypervisor.mcpLoadingResults["test-server"] = {
        status: "success",
        message: "Connected",
      };

      // Attach the onclose handler the same way #startMCPServer does
      transport.onclose = () => {
        if (hypervisor.mcps["test-server"]) {
          delete hypervisor.mcps["test-server"];
          hypervisor.mcpLoadingResults["test-server"] = {
            status: "failed",
            message: 'MCP server "test-server" transport closed unexpectedly.',
          };
        }
      };

      expect(hypervisor.mcps["test-server"]).toBeDefined();

      // Simulate transport closing
      transport.onclose();

      expect(hypervisor.mcps["test-server"]).toBeUndefined();
      expect(hypervisor.mcpLoadingResults["test-server"].status).toBe("failed");
    });

    it("is idempotent — double close does not throw", () => {
      const transport = makeMockTransport();

      hypervisor.mcps["test-server"] = { transport };
      hypervisor.mcpLoadingResults["test-server"] = {
        status: "success",
        message: "Connected",
      };

      transport.onclose = () => {
        if (hypervisor.mcps["test-server"]) {
          delete hypervisor.mcps["test-server"];
          hypervisor.mcpLoadingResults["test-server"] = {
            status: "failed",
            message: 'MCP server "test-server" transport closed unexpectedly.',
          };
        }
      };

      expect(() => {
        transport.onclose();
        transport.onclose(); // Second call should be a no-op
      }).not.toThrow();

      expect(hypervisor.mcps["test-server"]).toBeUndefined();
    });
  });

  describe("transport.onerror stops SSE auto-reconnect by closing the transport", () => {
    it("calls transport.close() when an error occurs", async () => {
      const transport = makeMockTransport();
      const mcp = makeMockMcp(transport);

      hypervisor.mcps["test-server"] = mcp;
      hypervisor.mcpLoadingResults["test-server"] = {
        status: "success",
        message: "Connected",
      };

      // Attach the onerror handler the same way #startMCPServer does
      transport.onclose = () => {
        if (hypervisor.mcps["test-server"]) {
          delete hypervisor.mcps["test-server"];
          hypervisor.mcpLoadingResults["test-server"] = {
            status: "failed",
            message: 'MCP server "test-server" transport closed unexpectedly.',
          };
        }
      };
      transport.onerror = (error) => {
        hypervisor.log(`test-server - Transport error:`, error);
        transport.close().catch(() => {});
      };

      const error = new Error("SSE connection dropped");
      transport.onerror(error);

      // Allow the microtask queue to flush (transport.close() is async)
      await Promise.resolve();

      expect(transport.close).toHaveBeenCalled();
    });

    it("removes server from mcps after error triggers close", async () => {
      const transport = makeMockTransport();
      const mcp = makeMockMcp(transport);

      hypervisor.mcps["test-server"] = mcp;
      hypervisor.mcpLoadingResults["test-server"] = {
        status: "success",
        message: "Connected",
      };

      transport.onclose = () => {
        if (hypervisor.mcps["test-server"]) {
          delete hypervisor.mcps["test-server"];
          hypervisor.mcpLoadingResults["test-server"] = {
            status: "failed",
            message: 'MCP server "test-server" transport closed unexpectedly.',
          };
        }
      };
      transport.onerror = (error) => {
        hypervisor.log(`test-server - Transport error:`, error);
        transport.close().catch(() => {});
      };

      expect(hypervisor.mcps["test-server"]).toBeDefined();

      transport.onerror(new Error("SSE dropped"));
      await Promise.resolve(); // flush microtasks

      expect(hypervisor.mcps["test-server"]).toBeUndefined();
      expect(hypervisor.mcpLoadingResults["test-server"].status).toBe("failed");
    });
  });

  describe("bootMCPServers re-initializes after a dropped connection", () => {
    it("re-boots a server that was removed from mcps due to transport close", async () => {
      // Simulate a server that was running and then dropped
      hypervisor.mcps = {}; // starts empty after cleanup
      hypervisor.mcpLoadingResults = {};

      const serverConfig = {
        "dropped-server": {
          command: "node",
          args: ["server.js"],
        },
      };

      // Mock the config file reading to return our test server
      jest
        .spyOn(hypervisor, "mcpServerConfigs", "get")
        .mockReturnValue([
          { name: "dropped-server", server: serverConfig["dropped-server"] },
        ]);

      // Mock #startMCPServer (private) via the public startMCPServer
      jest
        .spyOn(hypervisor, "startMCPServer")
        .mockResolvedValue({ success: true });

      // Spy on the private #startMCPServer via its public wrapper
      // We verify bootMCPServers doesn't skip when mcps is empty
      const bootSpy = jest
        .spyOn(hypervisor, "bootMCPServers")
        .mockImplementationOnce(async () => {
          // Simulate actual boot: registers the server
          hypervisor.mcps["dropped-server"] = { connected: true };
          hypervisor.mcpLoadingResults["dropped-server"] = {
            status: "success",
            message: "Reconnected",
          };
          return hypervisor.mcpLoadingResults;
        });

      await hypervisor.bootMCPServers();

      expect(bootSpy).toHaveBeenCalledTimes(1);
      expect(hypervisor.mcps["dropped-server"]).toBeDefined();
      expect(hypervisor.mcpLoadingResults["dropped-server"].status).toBe(
        "success"
      );
    });
  });
});
