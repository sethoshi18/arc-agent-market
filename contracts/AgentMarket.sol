// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IAgentMarket.sol";

interface IAgentIdentity {
    struct AgentIdentity {
        address owner;
        string name;
        string metadataURI;
        uint256 reputation;
        uint256 registeredAt;
        bool active;
    }
    function getAgent(uint256 tokenId) external view returns (AgentIdentity memory);
}

interface IAgentJob {
    function createJob(string calldata description, uint256 paymentAmount, uint256 deadline)
        external returns (uint256 jobId);
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title AgentMarket — Layer 3 of the Arc agentic commerce stack
/// @notice RFP board + bid matching + reputation-weighted discovery.
/// Reads ERC-8004 agent identity/reputation, auto-creates ERC-8183 jobs on bid acceptance.
contract AgentMarket is IAgentMarket {

    // ─── State ────────────────────────────────────────────────────────────────

    IAgentIdentity public immutable identityRegistry;
    IAgentJob      public immutable jobContract;
    IERC20         public immutable usdc;

    uint256 private _nextRFPId = 1;
    uint256 private _nextBidId = 1;

    // agentTokenId → listing
    mapping(uint256 => AgentListing) private _listings;
    uint256[] private _listedAgentIds;
    mapping(uint256 => bool) private _isListed;

    // capabilityHash → agentTokenIds
    mapping(bytes32 => uint256[]) private _capabilityIndex;

    mapping(uint256 => RFP)  private _rfps;
    mapping(uint256 => Bid)  private _bids;
    mapping(uint256 => uint256[]) private _rfpBids;   // rfpId → bidIds
    uint256[] private _openRFPIds;
    mapping(uint256 => uint256) private _rfpIndexInOpen; // rfpId → index in _openRFPIds

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _identityRegistry, address _jobContract, address _usdc) {
        identityRegistry = IAgentIdentity(_identityRegistry);
        jobContract      = IAgentJob(_jobContract);
        usdc             = IERC20(_usdc);
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyAgentOwner(uint256 tokenId) {
        IAgentIdentity.AgentIdentity memory agent = identityRegistry.getAgent(tokenId);
        require(agent.owner == msg.sender, "AgentMarket: not agent owner");
        require(agent.active, "AgentMarket: agent not active");
        _;
    }

    modifier onlyRFPClient(uint256 rfpId) {
        require(_rfps[rfpId].client == msg.sender, "AgentMarket: not RFP client");
        _;
    }

    // ─── Agent Listings ───────────────────────────────────────────────────────

    function listAgent(
        uint256 agentTokenId,
        uint256 hourlyRateUsdc,
        bytes32[] calldata capabilities,
        uint256 availableUntil
    ) external override onlyAgentOwner(agentTokenId) {
        require(hourlyRateUsdc > 0, "AgentMarket: zero rate");

        AgentListing storage listing = _listings[agentTokenId];
        bool wasListed = _isListed[agentTokenId];

        listing.agentTokenId  = agentTokenId;
        listing.owner         = msg.sender;
        listing.hourlyRateUsdc = hourlyRateUsdc;
        listing.capabilities  = capabilities;
        listing.availableUntil = availableUntil;
        listing.active        = true;

        if (!wasListed) {
            _listedAgentIds.push(agentTokenId);
            _isListed[agentTokenId] = true;
        }

        // Index by capability
        for (uint i = 0; i < capabilities.length; i++) {
            _capabilityIndex[capabilities[i]].push(agentTokenId);
        }

        emit AgentListed(agentTokenId, msg.sender, hourlyRateUsdc);
    }

    function delistAgent(uint256 agentTokenId) external override onlyAgentOwner(agentTokenId) {
        _listings[agentTokenId].active = false;
        emit AgentDelisted(agentTokenId);
    }

    function getListing(uint256 agentTokenId)
        external view override returns (AgentListing memory)
    {
        return _listings[agentTokenId];
    }

    function getListedAgents() external view override returns (uint256[] memory) {
        // Filter to active listings only
        uint256 count;
        for (uint i = 0; i < _listedAgentIds.length; i++) {
            if (_listings[_listedAgentIds[i]].active) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx;
        for (uint i = 0; i < _listedAgentIds.length; i++) {
            if (_listings[_listedAgentIds[i]].active) result[idx++] = _listedAgentIds[i];
        }
        return result;
    }

    function searchByCapability(bytes32 capabilityHash)
        external view override returns (uint256[] memory)
    {
        uint256[] storage candidates = _capabilityIndex[capabilityHash];
        // Filter to active + available listings, sort by reputation desc
        uint256 count;
        for (uint i = 0; i < candidates.length; i++) {
            AgentListing storage l = _listings[candidates[i]];
            if (l.active && (l.availableUntil == 0 || l.availableUntil > block.timestamp)) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256[] memory reps   = new uint256[](count);
        uint256 idx;
        for (uint i = 0; i < candidates.length; i++) {
            AgentListing storage l = _listings[candidates[i]];
            if (l.active && (l.availableUntil == 0 || l.availableUntil > block.timestamp)) {
                result[idx] = candidates[i];
                try identityRegistry.getAgent(candidates[i]) returns (IAgentIdentity.AgentIdentity memory a) {
                    reps[idx] = a.reputation;
                } catch {
                    reps[idx] = 0;
                }
                idx++;
            }
        }
        // Insertion sort by reputation descending (fine for expected small arrays)
        for (uint i = 1; i < count; i++) {
            uint256 keyId = result[i]; uint256 keyRep = reps[i];
            int j = int(i) - 1;
            while (j >= 0 && reps[uint(j)] < keyRep) {
                result[uint(j+1)] = result[uint(j)];
                reps[uint(j+1)]   = reps[uint(j)];
                j--;
            }
            result[uint(j+1)] = keyId;
            reps[uint(j+1)]   = keyRep;
        }
        return result;
    }

    // ─── RFP Lifecycle ────────────────────────────────────────────────────────

    function postRFP(
        string calldata description,
        uint256 budgetUsdc,
        bytes32[] calldata requiredCaps,
        uint256 deadline,
        uint256 biddingWindowSeconds
    ) external override returns (uint256 rfpId) {
        require(budgetUsdc > 0, "AgentMarket: zero budget");
        require(deadline > block.timestamp, "AgentMarket: deadline in past");

        rfpId = _nextRFPId++;
        RFP storage rfp = _rfps[rfpId];
        rfp.id           = rfpId;
        rfp.client       = msg.sender;
        rfp.description  = description;
        rfp.budgetUsdc   = budgetUsdc;
        rfp.requiredCaps = requiredCaps;
        rfp.deadline     = deadline;
        rfp.expiresAt    = block.timestamp + biddingWindowSeconds;
        rfp.status       = RFPStatus.Open;
        rfp.createdAt    = block.timestamp;

        _rfpIndexInOpen[rfpId] = _openRFPIds.length;
        _openRFPIds.push(rfpId);

        emit RFPPosted(rfpId, msg.sender, budgetUsdc);
    }

    function cancelRFP(uint256 rfpId) external override onlyRFPClient(rfpId) {
        RFP storage rfp = _rfps[rfpId];
        require(rfp.status == RFPStatus.Open, "AgentMarket: not open");
        rfp.status = RFPStatus.Cancelled;
        _removeFromOpen(rfpId);
        emit RFPCancelled(rfpId);
    }

    function getRFP(uint256 rfpId) external view override returns (RFP memory) {
        require(_rfps[rfpId].createdAt != 0, "AgentMarket: RFP not found");
        return _rfps[rfpId];
    }

    function getOpenRFPs() external view override returns (uint256[] memory) {
        return _openRFPIds;
    }

    // ─── Bidding ──────────────────────────────────────────────────────────────

    function submitBid(
        uint256 rfpId,
        uint256 agentTokenId,
        uint256 priceUsdc,
        string calldata proposal
    ) external override onlyAgentOwner(agentTokenId) returns (uint256 bidId) {
        RFP storage rfp = _rfps[rfpId];
        require(rfp.status == RFPStatus.Open, "AgentMarket: RFP not open");
        require(block.timestamp < rfp.expiresAt, "AgentMarket: bid window closed");
        require(priceUsdc <= rfp.budgetUsdc, "AgentMarket: bid exceeds budget");

        IAgentIdentity.AgentIdentity memory agent = identityRegistry.getAgent(agentTokenId);

        bidId = _nextBidId++;
        _bids[bidId] = Bid({
            id:               bidId,
            rfpId:            rfpId,
            agentTokenId:     agentTokenId,
            agentOwner:       msg.sender,
            priceUsdc:        priceUsdc,
            proposal:         proposal,
            agentReputation:  agent.reputation,
            active:           true,
            createdAt:        block.timestamp
        });
        _rfpBids[rfpId].push(bidId);

        emit BidSubmitted(rfpId, bidId, agentTokenId, priceUsdc);
    }

    function getBid(uint256 bidId) external view override returns (Bid memory) {
        require(_bids[bidId].createdAt != 0, "AgentMarket: bid not found");
        return _bids[bidId];
    }

    function getBidsByRFP(uint256 rfpId) external view override returns (uint256[] memory) {
        return _rfpBids[rfpId];
    }

    /// @notice Accept a bid: transfers USDC from client → this contract → AgentJob escrow.
    /// Creates an ERC-8183 job automatically and returns the job ID.
    function acceptBid(uint256 rfpId, uint256 bidId)
        external override onlyRFPClient(rfpId) returns (uint256 jobId)
    {
        RFP storage rfp = _rfps[rfpId];
        require(rfp.status == RFPStatus.Open, "AgentMarket: RFP not open");
        Bid storage bid = _bids[bidId];
        require(bid.rfpId == rfpId, "AgentMarket: bid/RFP mismatch");
        require(bid.active, "AgentMarket: bid not active");

        rfp.status      = RFPStatus.Matched;
        rfp.winningBidId = bidId;
        _removeFromOpen(rfpId);

        // Pull USDC from client
        require(
            usdc.transferFrom(msg.sender, address(this), bid.priceUsdc),
            "AgentMarket: USDC pull failed"
        );

        // Approve AgentJob to pull from this contract
        require(
            usdc.approve(address(jobContract), bid.priceUsdc),
            "AgentMarket: approve failed"
        );

        // Create the ERC-8183 job
        jobId = jobContract.createJob(rfp.description, bid.priceUsdc, rfp.deadline);

        emit BidAccepted(rfpId, bidId, jobId);
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _removeFromOpen(uint256 rfpId) internal {
        uint256 idx  = _rfpIndexInOpen[rfpId];
        uint256 last = _openRFPIds[_openRFPIds.length - 1];
        _openRFPIds[idx]          = last;
        _rfpIndexInOpen[last]     = idx;
        _openRFPIds.pop();
        delete _rfpIndexInOpen[rfpId];
    }
}
