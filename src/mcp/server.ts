/**
 * Arc Agent Market MCP Server
 *
 * Extends the arc-agent-payments MCP with marketplace tools:
 * discovery, RFP board, bidding, and bid acceptance.
 *
 * Add to Claude Desktop:
 * {
 *   "mcpServers": {
 *     "arc-market": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/arc-agent-market/src/mcp/server.ts"],
 *       "env": { "AGENT_PRIVATE_KEY": "0x...", "AGENT_MARKET_ADDRESS": "0x..." }
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AgentMarketClient, capHash, RFP_STATUS } from "../market/market.js";
import "dotenv/config";

const client = new AgentMarketClient();
const server = new Server({ name: "arc-agent-market", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "arc_list_agent",
      description: "List an AI agent on the Arc marketplace with hourly rate and capabilities.",
      inputSchema: { type: "object", properties: {
        agentTokenId:   { type: "number", description: "ERC-8004 token ID" },
        hourlyRateUsdc: { type: "number", description: "USDC per hour (e.g. 5.0)" },
        capabilities:   { type: "array", items: { type: "string" }, description: "e.g. ['code-review','data-analysis']" },
        availableUntil: { type: "number", description: "Unix timestamp (0 = indefinite)" },
      }, required: ["agentTokenId", "hourlyRateUsdc", "capabilities"] },
    },
    {
      name: "arc_browse_agents",
      description: "List all agents currently available on the Arc marketplace.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "arc_search_agents",
      description: "Find agents by capability (e.g. 'code-review', 'data-analysis'). Returns agents sorted by reputation.",
      inputSchema: { type: "object", properties: {
        capability: { type: "string", description: "Capability tag to search for" },
      }, required: ["capability"] },
    },
    {
      name: "arc_post_rfp",
      description: "Post a Request for Proposal on Arc. Agents can bid on it within the bidding window.",
      inputSchema: { type: "object", properties: {
        description:          { type: "string" },
        budgetUsdc:           { type: "number", description: "Max USDC budget" },
        requiredCapabilities: { type: "array", items: { type: "string" } },
        deadlineHours:        { type: "number", default: 48, description: "Hours to complete work" },
        biddingWindowHours:   { type: "number", default: 24, description: "Hours agents can bid" },
      }, required: ["description", "budgetUsdc"] },
    },
    {
      name: "arc_browse_rfps",
      description: "List all open RFPs on the Arc marketplace.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "arc_get_rfp",
      description: "Get full details of an RFP including status and winning bid.",
      inputSchema: { type: "object", properties: { rfpId: { type: "number" } }, required: ["rfpId"] },
    },
    {
      name: "arc_submit_bid",
      description: "Submit a bid on an open RFP as an agent.",
      inputSchema: { type: "object", properties: {
        rfpId:        { type: "number" },
        agentTokenId: { type: "number" },
        priceUsdc:    { type: "number", description: "USDC price (must be ≤ RFP budget)" },
        proposal:     { type: "string", description: "Agent's approach / pitch" },
      }, required: ["rfpId", "agentTokenId", "priceUsdc", "proposal"] },
    },
    {
      name: "arc_get_bids",
      description: "Get all bids on an RFP, sorted by agent reputation.",
      inputSchema: { type: "object", properties: { rfpId: { type: "number" } }, required: ["rfpId"] },
    },
    {
      name: "arc_accept_bid",
      description: "Accept a bid — locks USDC and auto-creates an ERC-8183 job. Returns the job ID.",
      inputSchema: { type: "object", properties: {
        rfpId: { type: "number" },
        bidId: { type: "number" },
      }, required: ["rfpId", "bidId"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "arc_list_agent": {
        const { agentTokenId, hourlyRateUsdc, capabilities, availableUntil = 0 } = args as any;
        const hash = await client.listAgent(BigInt(agentTokenId), hourlyRateUsdc, capabilities, availableUntil);
        return { content: [{ type: "text", text: `Agent ${agentTokenId} listed at ${hourlyRateUsdc} USDC/hr\nCapabilities: ${capabilities.join(", ")}\nTx: ${hash}` }] };
      }
      case "arc_browse_agents": {
        const ids = await client.getListedAgents();
        return { content: [{ type: "text", text: ids.length === 0 ? "No agents listed yet." : `Listed agent token IDs: ${ids.map(String).join(", ")}` }] };
      }
      case "arc_search_agents": {
        const { capability } = args as { capability: string };
        const ids = await client.searchByCapability(capability);
        return { content: [{ type: "text", text: ids.length === 0 ? `No agents found with capability: ${capability}` : `Agents with "${capability}" (sorted by reputation): ${ids.map(String).join(", ")}` }] };
      }
      case "arc_post_rfp": {
        const { description, budgetUsdc, requiredCapabilities = [], deadlineHours = 48, biddingWindowHours = 24 } = args as any;
        const { rfpId, hash } = await client.postRFP(description, budgetUsdc, requiredCapabilities, deadlineHours, biddingWindowHours);
        return { content: [{ type: "text", text: `RFP ${rfpId} posted!\nBudget: ${budgetUsdc} USDC\nBidding window: ${biddingWindowHours}h\nTx: ${hash}\nExplorer: https://testnet.arcscan.app/tx/${hash}` }] };
      }
      case "arc_browse_rfps": {
        const ids = await client.getOpenRFPs();
        return { content: [{ type: "text", text: ids.length === 0 ? "No open RFPs." : `Open RFP IDs: ${ids.map(String).join(", ")}` }] };
      }
      case "arc_get_rfp": {
        const { rfpId } = args as { rfpId: number };
        const rfp = await client.getRFP(BigInt(rfpId));
        return { content: [{ type: "text", text: JSON.stringify({ ...rfp, budget: `${Number(rfp.budgetUsdc) / 1_000_000} USDC`, deadline: new Date(Number(rfp.deadline) * 1000).toISOString() }, null, 2) }] };
      }
      case "arc_submit_bid": {
        const { rfpId, agentTokenId, priceUsdc, proposal } = args as any;
        const { bidId, hash } = await client.submitBid(BigInt(rfpId), BigInt(agentTokenId), priceUsdc, proposal);
        return { content: [{ type: "text", text: `Bid ${bidId} submitted!\nRFP: ${rfpId} | Price: ${priceUsdc} USDC\nTx: ${hash}` }] };
      }
      case "arc_get_bids": {
        const { rfpId } = args as { rfpId: number };
        const bidIds = await client.getBidsByRFP(BigInt(rfpId));
        if (bidIds.length === 0) return { content: [{ type: "text", text: `No bids on RFP ${rfpId} yet.` }] };
        const bids = await Promise.all(bidIds.map(id => client.getBid(id)));
        const sorted = bids.sort((a, b) => Number(b.agentReputation) - Number(a.agentReputation));
        return { content: [{ type: "text", text: sorted.map(b => `Bid ${b.id}: agent ${b.agentTokenId} | ${Number(b.priceUsdc)/1_000_000} USDC | rep ${b.reputationPct}\n  "${b.proposal}"`).join("\n\n") }] };
      }
      case "arc_accept_bid": {
        const { rfpId, bidId } = args as { rfpId: number; bidId: number };
        const { jobId, hash } = await client.acceptBid(BigInt(rfpId), BigInt(bidId));
        return { content: [{ type: "text", text: `Bid ${bidId} accepted!\nERC-8183 Job ID: ${jobId}\nUSADC locked in escrow.\nTx: ${hash}\nExplorer: https://testnet.arcscan.app/tx/${hash}` }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Arc Agent Market MCP server running");
