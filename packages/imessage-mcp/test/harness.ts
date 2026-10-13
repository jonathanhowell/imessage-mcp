// Runs the real server (mod.ts) as a subprocess and talks MCP to it over stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

export const MOD_PATH = new URL("../mod.ts", import.meta.url).pathname;

export const SERVER_FLAGS = [
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-sys",
  "--allow-ffi",
  "--allow-run",
  "--allow-net",
];

/** Keep the module cache when tests point HOME somewhere else. */
const denoDir = (): string =>
  Deno.env.get("DENO_DIR") ??
    join(Deno.env.get("HOME")!, "Library", "Caches", "deno");

export const serverEnv = (env: Record<string, string>) => ({
  DENO_DIR: denoDir(),
  ...env,
});

export interface Connected {
  client: Client;
  /** Calls a tool and returns its parsed JSON payload plus the error flag. */
  call(
    name: string,
    args?: Record<string, unknown>,
    // deno-lint-ignore no-explicit-any -- tests index arbitrary tool JSON
  ): Promise<{ isError: boolean; json: any; text: string }>;
  close(): Promise<void>;
}

export const connect = async (
  env: Record<string, string>,
  flags: string[] = SERVER_FLAGS,
): Promise<Connected> => {
  const transport = new StdioClientTransport({
    command: Deno.execPath(),
    args: ["run", "--quiet", ...flags, MOD_PATH],
    env: serverEnv(env),
    stderr: "pipe",
  });
  const client = new Client({ name: "imessage-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text: string }[];
      const text = content.map((c) => c.text).join("\n");
      let json: unknown = undefined;
      try {
        json = JSON.parse(content[0]!.text);
      } catch {
        // not JSON
      }
      return { isError: result.isError === true, json, text };
    },
    close: () => client.close(),
  };
};
