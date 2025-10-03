/** @ts-expect-error - SDK types resolution issues in TS compile; runtime import is valid */
import { createServer } from "@modelcontextprotocol/sdk";
import { registerMemory } from "./routes/memory";
import { registerEval } from "./routes/eval";
import { registerContext } from "./routes/context";

const server = createServer({ name: "memory-mcp", version: "0.1.0" });
registerContext(server);
registerMemory(server);
registerEval(server);

server.listen();
