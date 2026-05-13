# JIRA-28: Model Demand Difficulty and Opportunistic Detours

## Problem

The bot treats all demand cards as roughly equivalent in difficulty. In reality, some demands are trivially easy to fulfill (pickup Beer from any of 4 central European cities) while others are very hard (pickup Hops from Cardiff — the only source, behind mountains in Wales). Hard demands sit in the player's hand for many turns unless the player recognizes and acts on proximity opportunities.

Expert human players know:
- "I'm crossing into England anyway for a Newcastle delivery — might as well swing through Cardiff for Hops while I'm here"
- "Fish only comes from Aberdeen, Oslo, or Porto — all remote. If I'm near one, I should grab it even speculatively"
- "I've been holding this Cork → Oslo demand for 15 turns. Time to discard my hand unless I'm heading to Iberia soon"

The bot has none of this awareness.

## Supply Geography: Rarity Tiers

From `configuration/load_cities.json`:

### Tier 1: Unique Source (1 city — hardest to fulfill)
| Load | Source | Geographic Notes |
|------|--------|-----------------|
| **Flowers** | Holland | Central — easy access |
| **Ham** | Warszawa | Eastern — moderate |
| **Hops** | Cardiff | Remote — mountains, requires England track |
| **Marble** | Firenze | Central Italy — moderate |
| **Tobacco** | Napoli | Southern Italy — moderate |

### Tier 2: Dual Source (2 cities)
| Load | Sources | Geographic Notes |
|------|---------|-----------------|
| Bauxite | Budapest, Marseille | Widely separated |
| Cattle | Bern, Nantes | Central + Western |
| China | Birmingham, Leipzig | England + Central |
| Chocolate | Bruxelles, Zurich | Both central |
| Copper | Beograd, Wroclaw | Both eastern |
| Cork | Lisboa, Sevilla | Both Iberian — remote from central network |
| Imports | Antwerpen, Hamburg | Both central — easy |
| Oranges | Sevilla, Valencia | Both Iberian — remote |
| Tourists | London, Ruhr | Central + England |
| Wheat | Lyon, Toulouse | Southern France |

### Tier 3: Triple Source (3 cities)
| Load | Sources | Geographic Notes |
|------|---------|-----------------|
| Coal | Cardiff, Krakow, Wroclaw | 1 remote + 2 eastern |
| Fish | Aberdeen, Oslo, Porto | All geographically remote |
| Iron | Birmingham, Kaliningrad, Stockholm | Mixed — all somewhat peripheral |
| Labor | Beograd, Sarajevo, Zagreb | All Balkans — clustered remote |
| Potatoes | Belfast, Lodz, Szczecin | 1 island + 2 eastern |
| Sheep | Bilbao, Cork, Glasgow | All remote/mountainous |
| Steel | Birmingham, Luxembourg, Ruhr | Mixed accessibility |
| Wood | Oslo, Sarajevo, Stockholm | Scattered, 2 Nordic + 1 Balkans |

### Tier 4: Quad Source (4 cities — easiest)
| Load | Sources |
|------|---------|
| Beer | Dublin, Frankfurt, Munchen, Praha |
| Cars | Manchester, Munchen, Stuttgart, Torino |
| Cheese | Arhus, Bern, Holland, Kobenhavn |
| Machinery | Barcelona, Bremen, Goteborg, Nantes |
| Oil | Aberdeen, Beograd, Newcastle, Oslo |
| Wine | Bordeaux, Frankfurt, Porto, Wien |

## What Makes a Demand "Hard"

It's not just source count. A demand is hard when:
1. **Few supply cities** (Tier 1-2) — fewer chances to be near a source
2. **Remote supply geography** — sources behind ferries, in mountains, or at map edges (Cork from Lisboa, Fish from Aberdeen, Sheep from Glasgow)
3. **High build cost to reach** — mountains (Alpine 5M/mp), ferries (8-12M), etc.
4. **Low demand card frequency** — some loads appear on fewer demand cards, so you hold them longer

A composite "demand difficulty" score should combine: `supplyCount`, `geographic isolation of sources`, and `estimated build cost from nearest likely network position`.

## Proposed Changes

### 1. Scoring: Add `supplyRarity` factor to `scoreDemand()`

**File**: `src/server/services/ai/ContextBuilder.ts`

Add a new factor to the demand score formula that boosts hard-to-fulfill demands when the bot is already near a source:

```
Current:  score = (ROI / turns) + networkBonus + victoryBonus
Proposed: score = (ROI / turns) + networkBonus + victoryBonus + opportunityBonus
```

Where `opportunityBonus` is high when:
- The supply city is already on the bot's track (or within ~3 hexes of track)
- AND the load has few supply cities (Tier 1-2 rarity)
- AND the demand payout justifies the detour

This means: "you're near Cardiff and you have a Hops demand — this is a rare opportunity, boost this demand's priority."

When the bot is NOT near the source, rarity should slightly penalize the demand (harder to fulfill = lower baseline score) unless it's the highest payout option.

### 2. Context: Add `SUPPLY RARITY` section to LLM prompt

**File**: `src/server/services/ai/ContextBuilder.ts` (serialization) + `src/server/services/ai/prompts/systemPrompts.ts`

For each demand in context, add:
- `supplyCount`: number of cities that supply this load (1-4)
- `supplyRarityTag`: `UNIQUE SOURCE` / `LIMITED (2)` / `COMMON (3-4)`
- For unique/limited sources, list all source cities so the LLM knows the full map

Add to the system prompt strategic guidance:
```
12. SUPPLY RARITY: Demands for loads with few supply cities (marked UNIQUE SOURCE or LIMITED)
    are hard to fulfill. When you are near a rare supply city, strongly prefer picking up
    that load — you may not get another chance for many turns. Conversely, don't build
    expensive track JUST for a rare pickup unless the payout justifies it.
13. DETOUR OPPORTUNITIES: When your route passes within a few mileposts of a rare supply
    city, consider a detour even if the immediate payout is modest. Fulfilling a hard demand
    clears your hand for a new (potentially better) card.
```

### 3. Context: Add `GEOGRAPHIC CLUSTERS` static knowledge

Certain regions of the map have concentrated rare resources. The LLM should know:
- **British Isles cluster**: Fish (Aberdeen), Sheep (Glasgow), Coal (Cardiff), Hops (Cardiff), Potatoes (Belfast) — if you're building into Britain, maximize pickups
- **Iberian cluster**: Cork (Lisboa/Sevilla), Oranges (Sevilla/Valencia) — if you reach Iberia, grab both
- **Nordic cluster**: Fish (Oslo), Wood (Oslo/Stockholm), Iron (Stockholm), Oil (Aberdeen/Oslo) — Nordic track unlocks multiple rare loads
- **Balkans cluster**: Labor (Beograd/Sarajevo/Zagreb), Copper (Beograd/Wroclaw), Wood (Sarajevo) — building into Balkans unlocks a corridor of rare goods

This could be a static section in the system prompt or dynamically included when the bot's track reaches near these regions.

### 4. "Hand Staleness" indicator

Track how many turns each demand card has been held. After N turns (say 8-10), flag it:
- `STALE (held 10 turns)` — the LLM should either plan a deliberate route to fulfill it or consider discarding the hand
- This requires tracking card acquisition turn in bot memory (BotMemoryState)

## Implementation Approach

### Phase 1 (Small — scoring + context enrichment)
1. Add `supplyCount` to `computeDemandContext()` return value
2. Add `supplyRarityTag` derivation (1 source = UNIQUE, 2 = LIMITED, 3-4 = COMMON)
3. Include rarity in serialized demand context
4. Add opportunity bonus to `scoreDemand()` when supply is on/near network AND rarity is Tier 1-2
5. Add strategic guidance to system prompt (rules 12-13)

### Phase 2 (Medium — geographic cluster awareness)
1. Define static cluster data (British Isles, Iberia, Nordic, Balkans)
2. When bot's track frontier is near a cluster, include cluster context in prompt
3. Boost corridor scoring for routes that traverse a cluster

### Phase 3 (Optional — hand staleness)
1. Add `cardAcquiredTurn` to BotMemoryState
2. Track when cards enter hand
3. Add STALE tag to demand context after threshold turns
4. Add discard-hand guidance when multiple cards are stale

## Acceptance Criteria
- AC-1: Each demand in LLM context shows supply count and rarity tag
- AC-2: `scoreDemand()` includes opportunity bonus for rare loads near the bot's network
- AC-3: System prompt includes supply rarity and detour opportunity guidance
- AC-4: All existing ContextBuilder tests pass
- AC-5: New tests for rarity scoring edge cases (on-network rare source, off-network rare source, common load)
