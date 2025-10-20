#!/usr/bin/env node
// Test writing content that should have entities extracted

import { getInProcessMcpClient } from "../../tests/helpers/in-process-client.js";

async function main() {
  const client = getInProcessMcpClient();

  // Set context
  await client.callTool({
    name: "context.set_context",
    arguments: {
      tenant_id: "test",
      project_id: "entity-test",
      task_id: "test-1"
    }
  });

  // Write test content with entities
  const testContent = "I visited the Dell XPS 13 store on January 15th and met with Sarah from American Airlines. We discussed the meeting scheduled for 7 days later in San Francisco.";

  const writeResult = await client.callTool({
    name: "memory.write",
    arguments: {
      content: testContent
    }
  });

  console.log("Write result:", JSON.stringify(writeResult, null, 2));

  // Check what was indexed
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  // Wait a moment for indexing
  await new Promise(resolve => setTimeout(resolve, 2000));

  const { stdout } = await execAsync(
    `curl -s 'http://localhost:9200/mem-episodic-*/_ search?q=Dell&size=1' | jq '.hits.hits[0]._source | {content, extracted_entities, extracted_dates, extracted_numbers}'`
  );

  console.log("\nIndexed document:");
  console.log(stdout);
}

main().catch(console.error);
