import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
    public:  { http: ["https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export const config = {
  arc: {
    rpcUrl: process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network",
    chainId: 5042002,
  },
  contracts: {
    // arc-agent-payments (Layer 1 + 2) — already deployed
    agentIdentity: (process.env.AGENT_IDENTITY_REGISTRY_ADDRESS ?? "0x5Bef356f89425823FC7eebB3A6ED1A678F3b8233") as `0x${string}`,
    agentJob:      (process.env.AGENT_JOB_CONTRACT_ADDRESS      ?? "0xD698d15F776279c0213444a779941e8E0Cbe5094") as `0x${string}`,
    // arc-agent-market (Layer 3) — deployed below
    agentMarket:   (process.env.AGENT_MARKET_ADDRESS            ?? "") as `0x${string}`,
    usdc:          "0x3600000000000000000000000000000000000000" as `0x${string}`,
  },
  wallet: {
    privateKey: (process.env.AGENT_PRIVATE_KEY ?? "") as `0x${string}`,
  },
  mcp: {
    port: Number(process.env.MCP_SERVER_PORT ?? 3001),
  },
} as const;
