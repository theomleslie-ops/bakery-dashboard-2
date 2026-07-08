require('dotenv/config');
const { Composio } = require('@composio/core');

const { COMPOSIO_API_KEY, USER_ID } = process.env;

if (!COMPOSIO_API_KEY || !USER_ID) {
  throw new Error('COMPOSIO_API_KEY and USER_ID required in .env');
}

(async () => {
  const composioClient = new Composio({ apiKey: COMPOSIO_API_KEY });

  const composioSession = await composioClient.create(USER_ID, {
    toolkits: ['square'],
  });

  const composioMcpUrl = composioSession?.mcp.url;

  console.log(`MCP URL: ${composioMcpUrl}`);
  console.log(`\nUse this command to add to Claude Code:`);
  console.log(`claude mcp add --transport http square-composio "${composioMcpUrl}" --headers "X-API-Key:${COMPOSIO_API_KEY}"`);
})();
