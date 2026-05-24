Demand Scoring Gap Analysis: Single vs Double Delivery

# Status: Fixing Math.max bug only (JIRA-160)

Only the TripPlanner Math.max turn estimation bug (section 2, line 302) is being fixed.
All other items are documented for future consideration but are NOT being addressed now.

---

  There are 4 distinct scoring algorithms in the codebase, each operating at different pipeline stages. Here are the gaps I found:

  1. ContextBuilder.scoreDemand() (line 2319) — Per-Demand Scoring

  Formula: baseROI = (payout - totalTrackCost) / estimatedTurns, then rawScore = baseROI * (1 + corridorMultiplier)

  Gaps:
  - Scores each demand in isolation — never considers pairing potential. A demand worth 8M that chains perfectly with another 15M demand (shared
  corridor) scores worse than a standalone 12M demand, even though the pair yields 23M.
  **[NOT FIXING — by design. scoreDemand is a pre-filter for LLM context; the LLM reasons about pairings, and TripPlanner scores combinations.]**
  - No opponent track usage cost — if delivery requires 4M/turn opponent fees over multiple turns, that's invisible to the score.
  **[NOT FIXING — known limitation, low priority. Usage fees are rare in practice and hard to estimate without pathfinding.]**
  - Corridor multiplier caps at 0.5 (networkCities * 0.05, max 0.5) — in practice this is tiny. A demand passing through 10 cities gets the same
  bonus as one passing through 20.
  **[NOT FIXING — 50% bonus is already significant. The cap prevents corridor value from dominating over payout/cost fundamentals.]**
  - Affordability penalty is a cliff: if isAffordable=false, score drops to 5-30% of raw. But a demand that costs 21M (barely over cash) gets the
  same penalty structure as one costing 60M.
  **[NOT FIXING — this was already fixed by JIRA-51. The current code uses a proportional shortfallRatio gradient, not a cliff. This analysis predates that fix.]**

  2. TripPlanner.scoreCandidates() (line 245) — Multi-Stop Scoring

  Formula: score = (totalPayout - totalBuildCost) / estimatedTurns

  Gaps:
  - **>>> FIXING (JIRA-160) <<<** estimatedTurns uses Math.max() across stops, not sum (line 302: totalEstimatedTurns = Math.max(totalEstimatedTurns, matching.estimatedTurns)).
  This means a double delivery where stop A takes 5 turns and stop B takes 3 turns scores as if the whole trip takes 5 turns — massively overrating
   double deliveries where the second stop is far from the first.
  **Fix: Replace Math.max with chain-aware sequential estimation. First demand keeps its estimatedTurns (from bot position). Subsequent demands compute fresh inter-stop travel via estimateHopDistance.**
  - No chain distance penalty — a double delivery where the second pickup is 20 mileposts from the first delivery is scored the same as one where
  pickup2 is adjacent to delivery1. The estimatedTurns per-demand doesn't account for inter-stop travel.
  **[FIXED BY ABOVE — the chain-aware estimation directly addresses this by computing delivery[n-1]→supply[n] distance.]**
  - usageFeeEstimate is always 0 (line 317: usageFeeEstimate: 0, // no opponent track awareness per spec). Double deliveries that require opponent
  track are systematically overrated.
  **[NOT FIXING — same as ContextBuilder: usage fee estimation requires pathfinding not yet available in TripPlanner.]**
  - Build costs double-count: If both stops share track infrastructure (e.g., same supply city corridor), the build costs from context.demands are
  per-demand estimates that don't account for shared segments. A double delivery through Paris might pay the supply→Paris build cost twice.
  **[NOT FIXING — would require corridor overlap detection. Medium complexity, lower priority than turn estimation. The double-counting is conservative (overestimates cost), which is safer than underestimating.]**

  3. InitialBuildPlanner.scorePairing() (line 370) — Initial Build Double Delivery

  Formula: efficiency = (totalPayout - totalBuildCost) / estimatedTurns, then pairingScore = efficiency * 100 + hubBonus - peripheralPenalty -
  ferryPenalty

  Gaps:
  - Hardcoded speed of 9 (line 415: const speed = 9; // Freight default). If the bot has upgraded to Fast Freight (speed 12), pairings are
  evaluated with incorrect travel times, making distant pairings look worse than they are.
  **[NOT FIXING — InitialBuildPlanner runs only on initial build turns when all bots are Freight (speed 9). The hardcoded value is correct for its intended use.]**
  - No load availability check — computeDoubleDeliveryPairings doesn't verify that both loads are actually available at their supply cities. A
  pairing where one load has 0 chips available can win.
  **[NOT FIXING — low frequency issue. Load availability changes between turns; checking at plan time doesn't guarantee availability at pickup time.]**
  - Hub bonus is binary (15 points if shared starting city, 0 otherwise) — doesn't scale with how close two non-shared hubs are. Two options from
  adjacent major cities (3 hex apart) get 0 bonus while same-city gets 15.
  **[NOT FIXING — crude but functional. The peripheral penalty (30 points) has more impact. Could improve later but low priority.]**
  - REMOTE_DELIVERY_CITIES exclusion in expandDemandOptions (line 167) means certain high-value demands are invisible to pairing — even if the
  other leg of the pair naturally brings you close.
  **[NOT FIXING — intentional filter to avoid expensive peripheral routes in initial build. emergencyFallback() already bypasses this when needed.]**

  4. ContextBuilder.bestDemandForCard() (line 1417) — Per-Card Best Demand

  Gaps:
  - Ignores payout entirely — a 25M demand scores the same as a 7M demand if both have similar network proximity. It only considers network
  presence, track cost, core city, ferry, and availability.
  **[NOT FIXING — correct by design. This method picks the best SUPPLY CITY for a given demand card. Payout is identical regardless of supply city, so it's correctly excluded from the selection criteria.]**
  - Doesn't consider pairing synergy — picks the "best" demand per card in isolation, before the TripPlanner ever sees it.
  **[NOT FIXING — by design. bestDemandForCard selects supply city, not route. TripPlanner handles pairing at a later stage.]**

  Cross-Cutting Gaps

  ┌───────────────────────────────────────┬────────────────────────────┬───────────────────────────────────────────────────────────────────────┐
  │                  Gap                  │          Affects           │                                Impact                                 │
  ├───────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
  │ No shared-infrastructure deduction    │ TripPlanner,               │ Double deliveries that share track corridors aren't credited for the  │
  │ for double delivery                   │ ContextBuilder             │ savings                                                               │
  │ **[NOT FIXING — conservative bias,    │                            │                                                                       │
  │ lower priority]**                     │                            │                                                                       │
  ├───────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
  │ Single-demand scores feed LLM         │                            │ formatDemandView caps at 5 viable demands; the LLM may never see the  │
  │ context, but LLM sees different data  │ All paths                  │ 6th demand that pairs well with the 1st                               │
  │ than scorer                           │                            │                                                                       │
  │ **[NOT FIXING — could increase cap    │                            │                                                                       │
  │ later but adds token cost]**          │                            │                                                                       │
  ├───────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
  │ Victory bonus is annotation-only, not │                            │ formatVictoryBonus adds text but scoreDemand doesn't include          │
  │  in score                             │ ContextBuilder.scoreDemand │ victoryMajorCities in the numerical score — it only boosts via        │
  │ **[NOT FIXING — by design. Victory    │                            │ corridorMultiplier indirectly                                         │
  │ gets corridor boost + LLM annotation. │                            │                                                                       │
  │ Numeric double-counting would         │                            │                                                                       │
  │ conflict with LLM reasoning.]**       │                            │                                                                       │
  ├───────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
  │ estimatedTurns for on-train loads     │                            │ If a load is on-train and delivery is on-network, estimatedTurns can  │
  │ defaults to travel-only               │ ContextBuilder             │ be 1-2, making any on-train delivery dominate the score even if       │
  │ **[NOT FIXING — this is correct       │                            │ payout is low (7M/1turn = 7M/turn beats 25M/4turns = 6.25M/turn)      │
  │ behavior. On-train loads SHOULD score │                            │                                                                       │
  │ high per-turn — they require no build │                            │                                                                       │
  │ investment.]**                        │                            │                                                                       │
  ├───────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
  │                                       │                            │ Scoring never considers that fulfilling a demand lets you draw a      │
  │ No discard-and-redraw modeling        │ All                        │ replacement card. A quick 8M delivery that frees a card slot for a    │
  │ **[NOT FIXING — speculative value     │                            │ potential high-value draw is invisible                                │
  │ modeling is intractable. The LLM can  │                            │                                                                       │
  │ reason about this qualitatively.]**   │                            │                                                                       │
  └───────────────────────────────────────┴────────────────────────────┴───────────────────────────────────────────────────────────────────────┘

  Most Impactful Bug: Math.max vs Chain-Aware Turn Estimate in TripPlanner — **FIXING IN JIRA-160**

  The scoreCandidates method at line 302 does:
  totalEstimatedTurns = Math.max(totalEstimatedTurns, matching.estimatedTurns);

  This treats a multi-stop trip as taking the longest single leg's time, not the sum of travel between legs. For a pickup→deliver→pickup→deliver
  chain, the actual turn count should be roughly: travel(current→pickup1) + travel(pickup1→deliver1) + travel(deliver1→pickup2) +
  travel(pickup2→deliver2) plus build time. Instead it uses the max of the pre-computed per-demand estimatedTurns values, which were calculated
  independently from bot position to that demand's supply. This systematically overrates double deliveries where the second leg is geographically
  unrelated to the first.
