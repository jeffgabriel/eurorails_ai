# JIRA-15: City Card Counting — Deck-Based City Value Index

## Problem

The bot has no concept of which non-major cities are strategically valuable. It picks routes based on immediate demand card payouts without understanding that some cities are high-traffic hubs worth connecting for long-term reuse.

For example, Firenze supplies Marble (demanded on 15 of 146 cards, avg 27M payout) and appears as a delivery destination on 5 cards — but the bot has no way to know this. It treats Firenze the same as any other small city.

## Proposal

Pre-compute a **City Value Index** from the demand deck at game startup. For every city, calculate:

### Supply Value — how valuable as a pickup point?
- What resources does this city supply?
- How often are those resources demanded across the deck? (frequency out of 146 cards)
- What's the average payout when those resources are delivered?

### Delivery Value — how valuable as a destination?
- How many cards across the deck deliver to this city?
- What's the average payout for deliveries here?

## Examples from Deck Analysis

**Firenze**:
- Supply: Marble (demanded 15x across deck, avg 27M payout) — high-value pickup
- Delivery: appears on 5 cards (Cars 9M, Wheat 17M, China 22M, Copper 24M, Cork 44M) — avg 23M
- Verdict: connecting Firenze gives a reliable marble pickup AND a recurring delivery destination

**Antwerpen**:
- Supply: Imports (demanded 15x, avg 22M) — frequent pickup
- Delivery: appears on 9 cards, avg 15M — frequent but low payout
- Verdict: high-traffic hub, worth connecting even for modest payouts because it gets used constantly

**Napoli**:
- Supply: Tobacco (demanded 15x, avg 35M!) — premium resource
- Delivery: 9 cards, avg 29M — strong payouts
- Verdict: extremely valuable BUT deep in Italy (expensive to reach — geographic strategy applies)

**Szczecin**:
- Supply: Potatoes (demanded 15x, avg 20M) — frequent but low value
- Delivery: 5 cards, avg 22M — moderate
- Verdict: useful if already near Berlin, not worth a detour

## Full Deck Statistics

### Top Supply Hubs (by deck demand for their resources)

| City | Resources | Deck Demand | Resources Supplied |
|------|-----------|-------------|-------------------|
| Beograd | 3 | 46 | Copper, Labor, Oil |
| Birmingham | 3 | 45 | China, Iron, Steel |
| Oslo | 3 | 45 | Fish, Oil, Wood |
| Bern | 2 | 31 | Cattle, Cheese |
| Nantes | 2 | 31 | Cattle, Machinery |
| Sarajevo | 2 | 31 | Labor, Wood |
| Frankfurt | 2 | 30 | Beer, Wine |
| Munchen | 2 | 30 | Beer, Cars |
| Holland | 2 | 30 | Cheese, Flowers |
| Cardiff | 2 | 30 | Coal, Hops |
| Wroclaw | 2 | 30 | Coal, Copper |
| Sevilla | 2 | 30 | Cork, Oranges |
| Aberdeen | 2 | 30 | Fish, Oil |
| Porto | 2 | 30 | Fish, Wine |
| Stockholm | 2 | 30 | Iron, Wood |
| Ruhr | 2 | 30 | Steel, Tourists |

### Resource Demand Frequency (all 146 cards)

| Resource | Demanded | Avg Payout | Sources |
|----------|----------|-----------|---------|
| Cork | 15x | 52.9M | Lisboa, Sevilla |
| Oranges | 15x | 37.5M | Sevilla, Valencia |
| Tobacco | 15x | 35.3M | Napoli |
| Fish | 15x | 31.2M | Aberdeen, Oslo, Porto |
| Copper | 15x | 29.2M | Beograd, Wroclaw |
| Labor | 16x | 27.8M | Beograd, Sarajevo, Zagreb |
| Sheep | 16x | 27.4M | Bilbao, Cork, Glasgow |
| Hops | 15x | 27.1M | Cardiff |
| Flowers | 15x | 27.1M | Holland |
| Marble | 15x | 26.9M | Firenze |
| Ham | 15x | 26.3M | Warszawa |
| Tourists | 15x | 25.6M | London, Ruhr |
| Wood | 15x | 25.5M | Oslo, Sarajevo, Stockholm |
| Imports | 15x | 22.0M | Antwerpen, Hamburg |
| Wheat | 15x | 21.7M | Lyon, Toulouse |
| Bauxite | 15x | 21.2M | Budapest, Marseille |
| Coal | 15x | 21.1M | Cardiff, Krakow, Wroclaw |
| Machinery | 15x | 20.5M | Barcelona, Bremen, Goteborg, Nantes |
| Iron | 15x | 20.3M | Birmingham, Kaliningrad, Stockholm |
| Oil | 15x | 20.3M | Aberdeen, Beograd, Newcastle, Oslo |
| Chocolate | 15x | 20.3M | Bruxelles, Zurich |
| Potatoes | 15x | 20.0M | Belfast, Lodz, Szczecin |
| China | 15x | 19.6M | Birmingham, Leipzig |
| Beer | 15x | 19.3M | Dublin, Frankfurt, Munchen, Praha |
| Cattle | 16x | 20.2M | Bern, Nantes |
| Cheese | 15x | 16.4M | Arhus, Bern, Holland, Kobenhavn |
| Cars | 15x | 17.6M | Manchester, Munchen, Stuttgart, Torino |
| Steel | 15x | 17.6M | Birmingham, Luxembourg, Ruhr |
| Wine | 15x | 15.5M | Bordeaux, Frankfurt, Porto, Wien |

### Delivery Destination Frequency

All 8 major cities appear exactly 12x as delivery destinations. Non-major cities:

| City | Cards | Avg Payout | Total |
|------|-------|-----------|-------|
| Stockholm | 10 | 41M | 408M |
| Manchester | 9 | 27M | 244M |
| Napoli | 9 | 29M | 263M |
| Beograd | 9 | 28M | 253M |
| Glasgow | 9 | 28M | 249M |
| Hamburg | 9 | 24M | 212M |
| Lisboa | 9 | 34M | 310M |
| Budapest | 9 | 25M | 226M |
| Praha | 9 | 20M | 183M |
| Roma | 9 | 26M | 237M |
| Munchen | 9 | 23M | 206M |
| Zurich | 9 | 23M | 207M |
| Barcelona | 9 | 23M | 207M |
| Antwerpen | 9 | 15M | 139M |
| Birmingham | 9 | 23M | 206M |
| Bruxelles | 9 | 17M | 150M |
| Marseille | 9 | 21M | 193M |
| Torino | 9 | 18M | 163M |
| Warszawa | 9 | 21M | 193M |
| Lodz | 9 | 25M | 229M |

## Prompt Integration

### User Prompt — new CITY VALUE section

Filter to cities near the bot's network or on current demand cards. Don't dump all 70+ cities.

```
CITY VALUE (deck-based importance for nearby cities):
  Firenze: pickup Marble (15/146 cards want it, avg 27M) | 5 cards deliver here (avg 23M)
  Antwerpen: pickup Imports (15/146, avg 22M) | 9 cards deliver here (avg 15M)
  Hamburg: pickup Imports (15/146, avg 22M) | 9 cards deliver here (avg 24M)
  Bruxelles: pickup Chocolate (15/146, avg 20M) | 9 cards deliver here (avg 17M)
```

### System Prompt — reference in GEOGRAPHIC STRATEGY

Add a short note: "The CITY VALUE section shows how often each nearby city appears across all 146 demand cards. High-frequency cities are worth connecting even if no current card demands them — future cards probably will."

## Demand Ranking Enhancement

Also add build cost and estimated turns to the existing demand ranking line:

**Current format:**
```
#1 Iron Szczecin→Praha: score 45 (ROI: 12M, network: +2 cities, victory: +0 major)
```

**Proposed format:**
```
#1 Iron Szczecin→Praha: score 45 (payout: 17M, build: ~5M, ROI: 12M, ~4 turns, network: +2 cities, victory: +0 major)
```

This adds `payout`, `build cost`, and `estimated turns` — the critical inputs for capital velocity reasoning.

## Implementation Plan

1. **Compute once at game start**: Parse `demand_cards.json` + `load_cities.json` to build a `Map<string, CityValue>` with supply frequency, delivery frequency, and payout stats.

2. **Filter at prompt time**: In `serializeRoutePlanningPrompt()`, take existing NEARBY CITIES data and enrich with City Value Index. Only show cities within ~10 hexes of bot's network or on current demand cards.

3. **System prompt reference**: Add note in GEOGRAPHIC STRATEGY explaining what CITY VALUE means and how to use it.

4. **Demand ranking enhancement**: Add `payout`, `build cost`, and `~N turns` to the ranking line in both `serializePrompt()` and `serializeRoutePlanningPrompt()`.

## What This Enables

The LLM can reason: "Iron→Praha is only 17M payout, but Praha appears on 9 cards (avg 20M) and is a Beer pickup point (demanded 15x). Connecting Praha pays for itself over 3-4 deliveries. Meanwhile China→Oslo is 30M but Oslo only appears on 5 cards and requires a ferry — it's a one-time payoff with poor reuse."

Smart geographic reasoning driven by deck intelligence, not hard-coded heuristics.
