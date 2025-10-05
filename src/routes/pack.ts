// src/routes/pack.ts
// Exposes prompt packing as an MCP tool for agent ergonomics.

import { packPrompt } from "../services/packer.js";

type Section = { name: string; content: string; tokens?: number };

export function registerPack(server: any) {
  /**
   * pack.prompt
   * Request: { sections: [{ name, content, tokens? }] }
   * Response: { packed: string }
   *
   * Notes:
   * - Sections are packed according to config/packing.yaml order/limits.
   * - Optional tokens field per section is an approximate token count (if provided).
   */
  server.tool("pack.prompt", async (req: any) => {
    const sections = (req.params?.sections ?? []) as Section[];
    if (!Array.isArray(sections) || sections.length === 0) {
      throw new Error("pack.prompt requires sections: [{ name, content, tokens? }].");
    }
    for (const s of sections) {
      if (!s?.name || typeof s.name !== "string") {
        throw new Error("pack.prompt: each section requires a 'name' string.");
      }
      if (typeof s.content !== "string") {
        throw new Error("pack.prompt: each section requires a 'content' string.");
      }
    }

    const packed = packPrompt(sections);
    return { packed };
  });
}
