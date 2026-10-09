import { resolveRuntime } from "./plugin-runtime.mjs";

// Loading the MCP publishes tools only; setup and service startup remain explicit.
const { setBridgeRootResolver } = await import("../mcp-server.mjs");
// Resolve on every call: onboarding can adopt an old installation after MCP initialization.
setBridgeRootResolver(resolveRuntime);
