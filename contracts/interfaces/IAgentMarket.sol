// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAgentMarket — Discovery layer for ERC-8004 + ERC-8183 agentic commerce
/// @notice Completes the 3-layer Arc stack:
///   Layer 1: ERC-8004 AgentIdentity (who the agent is)
///   Layer 2: ERC-8183 AgentJob      (how work gets paid)
///   Layer 3: AgentMarket            (how clients and agents find each other)
interface IAgentMarket {

    // ─── Agent Listings ──────────────────────────────────────────────────────

    struct AgentListing {
        uint256 agentTokenId;       // ERC-8004 token ID
        address owner;
        uint256 hourlyRateUsdc;     // USDC per hour (6 decimals)
        bytes32[] capabilities;     // keccak256 hashed capability tags
        uint256 availableUntil;     // unix timestamp (0 = indefinite)
        bool active;
    }

    // ─── RFPs (Request for Proposals) ────────────────────────────────────────

    enum RFPStatus { Open, Matched, Cancelled }

    struct RFP {
        uint256 id;
        address client;
        string  description;
        uint256 budgetUsdc;         // Max USDC willing to pay (6 decimals)
        bytes32[] requiredCaps;     // keccak256 hashed required capabilities
        uint256 deadline;           // unix timestamp for work completion
        uint256 expiresAt;          // unix timestamp for bid window
        RFPStatus status;
        uint256 winningBidId;
        uint256 createdAt;
    }

    // ─── Bids ─────────────────────────────────────────────────────────────────

    struct Bid {
        uint256 id;
        uint256 rfpId;
        uint256 agentTokenId;       // ERC-8004 token of bidding agent
        address agentOwner;
        uint256 priceUsdc;          // USDC offered for the job (6 decimals)
        string  proposal;           // Agent's pitch / approach
        uint256 agentReputation;    // Snapshot of reputation at bid time (bps)
        bool    active;
        uint256 createdAt;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event AgentListed(uint256 indexed agentTokenId, address indexed owner, uint256 hourlyRate);
    event AgentDelisted(uint256 indexed agentTokenId);
    event RFPPosted(uint256 indexed rfpId, address indexed client, uint256 budget);
    event BidSubmitted(uint256 indexed rfpId, uint256 indexed bidId, uint256 indexed agentTokenId, uint256 price);
    event BidAccepted(uint256 indexed rfpId, uint256 indexed bidId, uint256 jobId);
    event RFPCancelled(uint256 indexed rfpId);

    // ─── Agent listing ────────────────────────────────────────────────────────

    function listAgent(
        uint256 agentTokenId,
        uint256 hourlyRateUsdc,
        bytes32[] calldata capabilities,
        uint256 availableUntil
    ) external;

    function delistAgent(uint256 agentTokenId) external;

    function getListing(uint256 agentTokenId) external view returns (AgentListing memory);

    function getListedAgents() external view returns (uint256[] memory agentTokenIds);

    function searchByCapability(bytes32 capabilityHash)
        external view returns (uint256[] memory agentTokenIds);

    // ─── RFP lifecycle ────────────────────────────────────────────────────────

    function postRFP(
        string calldata description,
        uint256 budgetUsdc,
        bytes32[] calldata requiredCaps,
        uint256 deadline,
        uint256 biddingWindowSeconds
    ) external returns (uint256 rfpId);

    function cancelRFP(uint256 rfpId) external;

    function getRFP(uint256 rfpId) external view returns (RFP memory);

    function getOpenRFPs() external view returns (uint256[] memory rfpIds);

    // ─── Bidding ──────────────────────────────────────────────────────────────

    function submitBid(
        uint256 rfpId,
        uint256 agentTokenId,
        uint256 priceUsdc,
        string calldata proposal
    ) external returns (uint256 bidId);

    function getBid(uint256 bidId) external view returns (Bid memory);

    function getBidsByRFP(uint256 rfpId) external view returns (uint256[] memory bidIds);

    /// @notice Accept a bid — locks USDC and auto-creates an ERC-8183 job
    /// @return jobId The created AgentJob job ID
    function acceptBid(uint256 rfpId, uint256 bidId) external returns (uint256 jobId);
}
