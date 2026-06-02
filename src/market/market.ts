import { createWalletClient, createPublicClient, http, parseAbi, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, config } from "../config.js";

export const MARKET_ABI = parseAbi([
  // Listings
  "function listAgent(uint256 agentTokenId, uint256 hourlyRateUsdc, bytes32[] capabilities, uint256 availableUntil)",
  "function delistAgent(uint256 agentTokenId)",
  "function getListing(uint256 agentTokenId) view returns ((uint256 agentTokenId, address owner, uint256 hourlyRateUsdc, bytes32[] capabilities, uint256 availableUntil, bool active))",
  "function getListedAgents() view returns (uint256[])",
  "function searchByCapability(bytes32 capabilityHash) view returns (uint256[])",
  // RFPs
  "function postRFP(string description, uint256 budgetUsdc, bytes32[] requiredCaps, uint256 deadline, uint256 biddingWindowSeconds) returns (uint256 rfpId)",
  "function cancelRFP(uint256 rfpId)",
  "function getRFP(uint256 rfpId) view returns ((uint256 id, address client, string description, uint256 budgetUsdc, bytes32[] requiredCaps, uint256 deadline, uint256 expiresAt, uint8 status, uint256 winningBidId, uint256 createdAt))",
  "function getOpenRFPs() view returns (uint256[])",
  // Bids
  "function submitBid(uint256 rfpId, uint256 agentTokenId, uint256 priceUsdc, string proposal) returns (uint256 bidId)",
  "function getBid(uint256 bidId) view returns ((uint256 id, uint256 rfpId, uint256 agentTokenId, address agentOwner, uint256 priceUsdc, string proposal, uint256 agentReputation, bool active, uint256 createdAt))",
  "function getBidsByRFP(uint256 rfpId) view returns (uint256[])",
  "function acceptBid(uint256 rfpId, uint256 bidId) returns (uint256 jobId)",
  // Events
  "event AgentListed(uint256 indexed agentTokenId, address indexed owner, uint256 hourlyRate)",
  "event RFPPosted(uint256 indexed rfpId, address indexed client, uint256 budget)",
  "event BidSubmitted(uint256 indexed rfpId, uint256 indexed bidId, uint256 indexed agentTokenId, uint256 price)",
  "event BidAccepted(uint256 indexed rfpId, uint256 indexed bidId, uint256 jobId)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const RFP_STATUS = { 0: "Open", 1: "Matched", 2: "Cancelled" } as const;

/** Convert a capability string like "code-review" to its bytes32 hash */
export function capHash(capability: string): `0x${string}` {
  return keccak256(toHex(capability));
}

export class AgentMarketClient {
  private walletClient;
  private publicClient;

  constructor() {
    const account = privateKeyToAccount(config.wallet.privateKey);
    this.publicClient = createPublicClient({ chain: arcTestnet, transport: http(config.arc.rpcUrl) });
    this.walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(config.arc.rpcUrl) });
  }

  get address() { return this.walletClient.account.address; }

  private get market() {
    return { address: config.contracts.agentMarket, abi: MARKET_ABI };
  }

  // ─── Listings ──────────────────────────────────────────────────────────────

  async listAgent(agentTokenId: bigint, hourlyRateUsdc: number, capabilities: string[], availableUntil = 0) {
    const caps = capabilities.map(capHash) as `0x${string}`[];
    const { request } = await this.publicClient.simulateContract({
      ...this.market, functionName: "listAgent",
      args: [agentTokenId, BigInt(Math.round(hourlyRateUsdc * 1_000_000)), caps, BigInt(availableUntil)],
      account: this.walletClient.account,
    });
    const hash = await this.walletClient.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Agent ${agentTokenId} listed at ${hourlyRateUsdc} USDC/hr`);
    return hash;
  }

  async getListedAgents() {
    return this.publicClient.readContract({ ...this.market, functionName: "getListedAgents" });
  }

  async searchByCapability(capability: string) {
    return this.publicClient.readContract({
      ...this.market, functionName: "searchByCapability", args: [capHash(capability)],
    });
  }

  // ─── RFPs ─────────────────────────────────────────────────────────────────

  async postRFP(description: string, budgetUsdc: number, requiredCaps: string[], deadlineHours = 48, biddingWindowHours = 24) {
    const budget   = BigInt(Math.round(budgetUsdc * 1_000_000));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineHours * 3600);
    const window   = BigInt(biddingWindowHours * 3600);
    const caps     = requiredCaps.map(capHash) as `0x${string}`[];
    const { request } = await this.publicClient.simulateContract({
      ...this.market, functionName: "postRFP",
      args: [description, budget, caps, deadline, window],
      account: this.walletClient.account,
    });
    const hash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    const log = receipt.logs[0];
    const rfpId = BigInt(log.topics[1] ?? "0x1");
    console.log(`✅ RFP ${rfpId} posted — budget: ${budgetUsdc} USDC`);
    return { rfpId, hash };
  }

  async getOpenRFPs() {
    return this.publicClient.readContract({ ...this.market, functionName: "getOpenRFPs" });
  }

  async getRFP(rfpId: bigint) {
    const rfp = await this.publicClient.readContract({ ...this.market, functionName: "getRFP", args: [rfpId] });
    return { ...rfp, statusLabel: RFP_STATUS[rfp.status as keyof typeof RFP_STATUS] };
  }

  // ─── Bids ─────────────────────────────────────────────────────────────────

  async submitBid(rfpId: bigint, agentTokenId: bigint, priceUsdc: number, proposal: string) {
    const price = BigInt(Math.round(priceUsdc * 1_000_000));
    const { request } = await this.publicClient.simulateContract({
      ...this.market, functionName: "submitBid",
      args: [rfpId, agentTokenId, price, proposal],
      account: this.walletClient.account,
    });
    const hash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    const log = receipt.logs[0];
    const bidId = BigInt(log.topics[2] ?? "0x1");
    console.log(`✅ Bid ${bidId} submitted for RFP ${rfpId} — ${priceUsdc} USDC`);
    return { bidId, hash };
  }

  async getBidsByRFP(rfpId: bigint) {
    return this.publicClient.readContract({ ...this.market, functionName: "getBidsByRFP", args: [rfpId] });
  }

  async getBid(bidId: bigint) {
    const bid = await this.publicClient.readContract({ ...this.market, functionName: "getBid", args: [bidId] });
    return { ...bid, reputationPct: `${Number(bid.agentReputation) / 100}%` };
  }

  /** Accept a bid: approves USDC spend, calls acceptBid, returns ERC-8183 jobId */
  async acceptBid(rfpId: bigint, bidId: bigint): Promise<{ jobId: bigint; hash: `0x${string}` }> {
    const bid = await this.publicClient.readContract({ ...this.market, functionName: "getBid", args: [bidId] });
    const price = bid.priceUsdc;

    // Approve USDC
    const allowance = await this.publicClient.readContract({
      address: config.contracts.usdc, abi: ERC20_ABI, functionName: "allowance",
      args: [this.address, config.contracts.agentMarket],
    });
    if (allowance < price) {
      const { request: approveReq } = await this.publicClient.simulateContract({
        address: config.contracts.usdc, abi: ERC20_ABI, functionName: "approve",
        args: [config.contracts.agentMarket, price], account: this.walletClient.account,
      });
      const approveTx = await this.walletClient.writeContract(approveReq);
      await this.publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    const { request } = await this.publicClient.simulateContract({
      ...this.market, functionName: "acceptBid", args: [rfpId, bidId],
      account: this.walletClient.account,
    });
    const hash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    const log = receipt.logs[receipt.logs.length - 1];
    const jobId = BigInt(log.topics[3] ?? "0x1");
    console.log(`✅ Bid ${bidId} accepted → ERC-8183 job ${jobId} created`);
    return { jobId, hash };
  }
}
