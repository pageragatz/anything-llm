const { SystemPromptVariables } = require("../../models/systemPromptVariables");
const prisma = require("../../utils/prisma");

// Mock the MCP compatibility layer so tests don't need a running MCP server.
jest.mock("../../utils/MCP", () => {
  return jest.fn().mockImplementation(() => ({
    mcps: {
      "test-server": {
        callTool: jest.fn().mockResolvedValue({
          content: [{ type: "text", text: "Artist — Track Title" }],
        }),
      },
      "json-server": {
        callTool: jest.fn().mockResolvedValue({ result: 42 }),
      },
      "slow-server": {
        callTool: jest.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 10_000))
        ),
      },
      "error-server": {
        callTool: jest.fn().mockRejectedValue(new Error("Tool call failed")),
      },
    },
  }));
});

const mockUser = {
  id: 1,
  username: "john.doe",
  bio: "I am a test user",
};

const mockWorkspace = {
  id: 1,
  name: "Test Workspace",
  slug: 'test-workspace',
};

const mockSystemPromptVariables = [
  {
    id: 1,
    key: "mystaticvariable",
    value: "AnythingLLM testing runtime",
    description: "A test variable",
    type: "static",
    userId: null,
  },
];

describe("SystemPromptVariables.expandSystemPromptVariables", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock just the Prisma actions since that is what is used by default values
    prisma.system_prompt_variables.findMany = jest.fn().mockResolvedValue(mockSystemPromptVariables);
    prisma.workspaces.findUnique = jest.fn().mockResolvedValue(mockWorkspace);
    prisma.users.findUnique = jest.fn().mockResolvedValue(mockUser);
  });

  it("should expand user-defined system prompt variables", async () => {
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {mystaticvariable}");
    expect(variables).toBe(`Hello ${mockSystemPromptVariables[0].value}`);
  });

  it("should expand workspace-defined system prompt variables", async () => {
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {workspace.name}", null, mockWorkspace.id);
    expect(variables).toBe(`Hello ${mockWorkspace.name}`);
  });

  it("should expand user-defined system prompt variables", async () => {
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {user.name}", mockUser.id);
    expect(variables).toBe(`Hello ${mockUser.username}`);
  });

  it("should work with any combination of variables", async () => {
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {mystaticvariable} {workspace.name} {user.name}", mockUser.id, mockWorkspace.id);
    expect(variables).toBe(`Hello ${mockSystemPromptVariables[0].value} ${mockWorkspace.name} ${mockUser.username}`);
  });

  it('should fail gracefully with invalid variables that are undefined for any reason', async () => {
    // Undefined sub-fields on valid classes are push to a placeholder [Class prop]. This is expected behavior.
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {invalid.variable} {user.password} the current user is {user.name} on workspace id #{workspace.id}", null, null);
    expect(variables).toBe("Hello {invalid.variable} [User password] the current user is [User name] on workspace id #[Workspace ID]");
  });
});

describe("SystemPromptVariables.expandSystemPromptVariables - MCP variables", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.system_prompt_variables.findMany = jest.fn().mockResolvedValue([]);
    prisma.workspaces.findUnique = jest.fn().mockResolvedValue(null);
    prisma.users.findUnique = jest.fn().mockResolvedValue(null);

    // Clear the module-level TTL cache between tests so results don't bleed across.
    const MCPCompatibilityLayer = require("../../utils/MCP");
    MCPCompatibilityLayer.mockClear();
  });

  it("should expand an {mcp.<server>.<tool>} variable using text content blocks", async () => {
    const result = await SystemPromptVariables.expandSystemPromptVariables(
      "Now playing: {mcp.test-server.get_now_playing}"
    );
    expect(result).toBe("Now playing: Artist — Track Title");
  });

  it("should fall back to JSON when MCP result has no text content blocks", async () => {
    const result = await SystemPromptVariables.expandSystemPromptVariables(
      "Answer: {mcp.json-server.compute}"
    );
    expect(result).toBe('Answer: {"result":42}');
  });

  it("should return empty string when the MCP server is not running", async () => {
    const result = await SystemPromptVariables.expandSystemPromptVariables(
      "Status: {mcp.unknown-server.ping}"
    );
    expect(result).toBe("Status: ");
  });

  it("should return empty string when the MCP tool call throws", async () => {
    const result = await SystemPromptVariables.expandSystemPromptVariables(
      "Info: {mcp.error-server.bad_tool}"
    );
    expect(result).toBe("Info: ");
  });

  it("should return empty string when the MCP tool call times out", async () => {
    jest.useFakeTimers();
    const promise = SystemPromptVariables.expandSystemPromptVariables(
      "Loading: {mcp.slow-server.slow_tool}"
    );
    await jest.advanceTimersByTimeAsync(4_000);
    const result = await promise;
    jest.useRealTimers();
    expect(result).toBe("Loading: ");
  });

  it("should return empty string for a malformed mcp variable with no tool segment", async () => {
    const result = await SystemPromptVariables.expandSystemPromptVariables(
      "Bad: {mcp.only-server}"
    );
    expect(result).toBe("Bad: ");
  });

  it("should expand mcp variables alongside static and workspace variables", async () => {
    prisma.workspaces.findUnique.mockResolvedValue({ name: "My Workspace" });
    const result = await SystemPromptVariables.expandSystemPromptVariables(
      "Workspace: {workspace.name}. Now playing: {mcp.test-server.get_now_playing}",
      null,
      1
    );
    expect(result).toBe("Workspace: My Workspace. Now playing: Artist — Track Title");
  });
});