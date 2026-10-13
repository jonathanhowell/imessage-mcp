#!/usr/bin/env -S deno run --allow-read --allow-env --allow-sys --allow-run --allow-ffi

import { run } from "./src/index.ts";

// Re-export the main MCP server entry point
export * from "./src/index.ts";

// For direct execution
if (import.meta.main) run();
