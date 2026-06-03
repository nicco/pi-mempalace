import { Type } from "@sinclair/typebox";
import type { McpToolDefinition, McpErrorKind } from "./mcp-transport";

// Re-export for backward compatibility
export { getMcpErrorKind, createTaggedMcpError } from "./mcp-transport";
export type { McpToolDefinition, McpErrorKind } from "./mcp-transport";

// schemaToTypeBox is private (not exported); mcpToolSchemaToTypeBox and
// normalizeMcpToolResult are defined as exported functions below.

// ---------------------------------------------------------------------------
// MemPalaceMcpClient — thin facade delegating to McpTransport
// ---------------------------------------------------------------------------

export class MemPalaceMcpClient {
  private transport?: import("./mcp-transport").McpTransport;

  setTransport(t: import("./mcp-transport").McpTransport): void {
    this.transport = t;
  }

  get isConnected(): boolean {
    return this.transport?.isConnected ?? false;
  }

  getCommandLine(): string {
    return this.transport?.getCommandLine() ?? "";
  }

  getStderr(): string {
    return this.transport?.getStderr() ?? "";
  }

  getTools(): McpToolDefinition[] {
    if (!this.transport) return [];
    return this.transport.getTools();
  }

  async connect(signal?: AbortSignal): Promise<{ commandLine: string; tools: McpToolDefinition[] }> {
    if (!this.transport) {
      throw new Error("No transport set. Call setTransport() before connect().");
    }
    await this.transport.connect(signal);
    const tools = await this.transport.listTools(signal);
    return { commandLine: this.transport!.getCommandLine(), tools };
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.transport) {
      throw new Error("No transport set. Call setTransport() before callTool().");
    }
    return this.transport.callTool(name, args, signal);
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }
}

// ---------------------------------------------------------------------------
// Transport-agnostic utilities
// ---------------------------------------------------------------------------

function schemaToTypeBox(schema: JsonSchema | undefined): unknown {
  if (!schema) return Type.Any();
  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
    return Type.Union(schema.enum.map((value) => Type.Literal(value as string)));
  }

  switch (schema.type) {
    case "string":
      return Type.String({
        description: schema.description,
        maxLength: schema.maxLength,
      });
    case "integer":
      return Type.Integer({
        description: schema.description,
        minimum: schema.minimum,
        maximum: schema.maximum,
      });
    case "number":
      return Type.Number({
        description: schema.description,
        minimum: schema.minimum,
        maximum: schema.maximum,
      });
    case "boolean":
      return Type.Boolean({ description: schema.description });
    case "array":
      return Type.Array(schemaToTypeBox(schema.items) as never, { description: schema.description });
    case "object": {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const mapped = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          required.has(key) ? schemaToTypeBox(value) : Type.Optional(schemaToTypeBox(value) as never),
        ]),
      );
      return Type.Object(mapped, { description: schema.description });
    }
    default:
      return Type.Any({ description: schema.description });
  }
}

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
};

export function mcpToolSchemaToTypeBox(tool: McpToolDefinition) {
  const schema = tool.inputSchema;
  if (!schema || schema.type !== "object") {
    return Type.Object({});
  }
  return schemaToTypeBox(schema);
}

export function normalizeMcpToolResult(result: unknown) {
  const payload = (result as { content?: Array<{ type?: string; text?: string }> } | undefined) ?? {};
  const text = payload.content?.find((item) => item.type === "text")?.text ?? JSON.stringify(result, null, 2);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep plain text
  }
  return {
    text,
    parsed,
    content: [{ type: "text" as const, text }],
    details: { rawResult: result, parsed },
  };
}
