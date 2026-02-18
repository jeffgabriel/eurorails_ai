# LLM Bot Technical Specification

**Companion to [prd-aiLLM.md](./prd-aiLLM.md)** — contains all code-level specifications: module interfaces, pseudocode, and the GameStateSerializer design.

---

## 1. Module: `LLMStrategyBrain`

```typescript
// src/server/services/ai/LLMStrategyBrain.ts

import { WorldSnapshot, FeasibleOption, AIActionType, BotMemoryState } from '../../../shared/types/GameTypes';

interface LLMSelectionResult {
  moveOptionIndex: number;    // -1 = skip movement
  buildOptionIndex: number;
  reasoning: string;
  planHorizon: string;
  model: string;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
  wasGuardrailOverride: boolean;
  guardrailReason?: string;
}

interface LLMStrategyConfig {
  archetype: ArchetypeId;
  skillLevel: 'easy' | 'medium' | 'hard';
  provider: LLMProvider;  // from BotConfig.provider ?? LLMProvider.Anthropic
  model?: string;         // from BotConfig.model; if omitted, uses LLM_DEFAULT_MODELS[provider][skillLevel]
  apiKey: string;         // ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY based on provider
  timeoutMs: number;      // 10000 for Easy, 15000 for Medium/Hard
  maxRetries: number;     // 1
}

class LLMStrategyBrain {
  constructor(config: LLMStrategyConfig) {}

  /**
   * Select both a movement option and a build option in a single LLM call.
   * Called once per turn after Phase 0 completes.
   */
  async selectOptions(
    snapshot: WorldSnapshot,
    moveOptions: FeasibleOption[],
    buildOptions: FeasibleOption[],
    botMemory: BotMemoryState,
  ): Promise<LLMSelectionResult> {
    // 1. Serialize game state with both option lists + memory
    const systemPrompt = this.getSystemPrompt(this.config.archetype, this.config.skillLevel);
    const userPrompt = GameStateSerializer.serialize(
      snapshot, moveOptions, buildOptions, botMemory, this.config.skillLevel
    );

    // 2. Call API
    const start = Date.now();
    let response: AnthropicResponse;
    try {
      response = await this.callAPI(systemPrompt, userPrompt);
    } catch (error) {
      // Retry with reduced prompt (no opponents, shorter descriptions)
      try {
        const shortPrompt = GameStateSerializer.serializeMinimal(
          snapshot, moveOptions, buildOptions
        );
        response = await this.callAPI(systemPrompt, shortPrompt);
      } catch (retryError) {
        // Fall back to heuristic
        return this.heuristicFallback(moveOptions, buildOptions, snapshot);
      }
    }

    // 3. Parse response — expects { moveOption, buildOption, reasoning, planHorizon }
    const parsed = ResponseParser.parse(response, moveOptions.length, buildOptions.length);

    // 4. Apply guardrails
    const guardrailResult = GuardrailEnforcer.check(
      moveOptions[parsed.moveOptionIndex],
      buildOptions[parsed.buildOptionIndex],
      moveOptions, buildOptions, snapshot
    );

    return {
      moveOptionIndex: guardrailResult.moveOverridden
        ? guardrailResult.correctedMoveIndex!
        : parsed.moveOptionIndex,
      buildOptionIndex: guardrailResult.buildOverridden
        ? guardrailResult.correctedBuildIndex!
        : parsed.buildOptionIndex,
      reasoning: parsed.reasoning,
      planHorizon: parsed.planHorizon,
      model: this.getModel(),
      latencyMs: Date.now() - start,
      tokenUsage: response.usage,
      wasGuardrailOverride: guardrailResult.moveOverridden || guardrailResult.buildOverridden,
      guardrailReason: guardrailResult.reason,
    };
  }

  private getModel(): string {
    // Explicit model override takes priority
    if (this.config.model) return this.config.model;
    // Otherwise use default for provider + skill level
    return LLM_DEFAULT_MODELS[this.config.provider][this.config.skillLevel];
  }

  private heuristicFallback(
    moveOptions: FeasibleOption[],
    buildOptions: FeasibleOption[],
    snapshot: WorldSnapshot
  ): LLMSelectionResult {
    // Movement: pick the move toward highest-payoff deliverable load
    let bestMoveIndex = -1;
    let bestMoveScore = 0;
    for (let i = 0; i < moveOptions.length; i++) {
      const o = moveOptions[i];
      if (!o.feasible) continue;
      const score = (o.payment ?? 0) - (o.estimatedCost ?? 0);
      if (score > bestMoveScore) { bestMoveScore = score; bestMoveIndex = i; }
    }

    // Build: pick the highest chainScore option
    let bestBuildIndex = buildOptions.length - 1; // default to PassTurn (last)
    let bestChainScore = 0;
    for (let i = 0; i < buildOptions.length; i++) {
      const o = buildOptions[i];
      if (!o.feasible) continue;
      if ((o.chainScore ?? 0) > bestChainScore) {
        bestChainScore = o.chainScore ?? 0;
        bestBuildIndex = i;
      }
    }

    return {
      moveOptionIndex: bestMoveIndex,
      buildOptionIndex: bestBuildIndex,
      reasoning: "LLM unavailable — using heuristic fallback",
      planHorizon: "N/A",
      model: "heuristic-fallback",
      latencyMs: 0,
      tokenUsage: { input: 0, output: 0 },
      wasGuardrailOverride: false,
    };
  }
}
```

---

## 2. API Call Format

```typescript
// API call is abstracted behind a provider adapter.
// Each adapter normalizes the request/response format.
const response = await this.providerAdapter.chat({
  model: this.getModel(),
  maxTokens: 256,       // Response is short JSON — keep this tight
  temperature: 0.3,     // Low temperature for consistent play. 0.5 for Easy.
  systemPrompt,
  userPrompt,
});

// Provider adapters handle the differences:
// - Anthropic: POST /v1/messages with x-api-key header, response.content[0].text
// - Google:    POST /v1beta/models/{model}:generateContent, response.candidates[0].content.parts[0].text
// The adapter returns a normalized { text, usage: { input, output } } object.
```

---

## 3. Response Parsing

```typescript
class ResponseParser {
  static parse(
    response: AnthropicResponse,
    moveOptionCount: number,
    buildOptionCount: number,
  ): ParsedSelection {
    const text = response.content[0].text.trim();

    // Strip markdown fences if present
    const clean = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();

    let parsed: any;
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Try to extract indices via regex if JSON parsing fails
      const moveMatch = text.match(/"moveOption"\s*:\s*(-?\d+)/);
      const buildMatch = text.match(/"buildOption"\s*:\s*(\d+)/);
      if (moveMatch && buildMatch) {
        return {
          moveOptionIndex: parseInt(moveMatch[1]),
          buildOptionIndex: parseInt(buildMatch[1]),
          reasoning: "Response was malformed but indices were extractable",
          planHorizon: "",
        };
      }
      throw new Error(`Unparseable LLM response: ${text.substring(0, 200)}`);
    }

    // Validate moveOption index (-1 = skip movement, otherwise 0..N-1)
    const moveIndex = parsed.moveOption ?? -1;
    if (typeof moveIndex !== 'number' || moveIndex < -1 || moveIndex >= moveOptionCount) {
      throw new Error(`Invalid move index: ${moveIndex} (valid: -1 to ${moveOptionCount - 1})`);
    }

    // Validate buildOption index (0..N-1)
    const buildIndex = parsed.buildOption;
    if (typeof buildIndex !== 'number' || buildIndex < 0 || buildIndex >= buildOptionCount) {
      throw new Error(`Invalid build index: ${buildIndex} (valid: 0-${buildOptionCount - 1})`);
    }

    return {
      moveOptionIndex: moveIndex,
      buildOptionIndex: buildIndex,
      reasoning: String(parsed.reasoning || ''),
      planHorizon: String(parsed.planHorizon || ''),
    };
  }
}
```

---

## 4. Guardrail Enforcer

```typescript
import { FeasibleOption, AIActionType, WorldSnapshot } from '../../../shared/types/GameTypes';

interface GuardrailResult {
  moveOverridden: boolean;
  buildOverridden: boolean;
  correctedMoveIndex?: number;
  correctedBuildIndex?: number;
  reason?: string;
}

class GuardrailEnforcer {
  /**
   * Check both the move and build selections against hard rules.
   * Uses FeasibleOption.action (AIActionType enum), not .type.
   */
  static check(
    selectedMove: FeasibleOption | undefined,  // undefined if moveIndex === -1
    selectedBuild: FeasibleOption,
    allMoveOptions: FeasibleOption[],
    allBuildOptions: FeasibleOption[],
    snapshot: WorldSnapshot
  ): GuardrailResult {
    let moveOverridden = false;
    let buildOverridden = false;
    let correctedMoveIndex: number | undefined;
    let correctedBuildIndex: number | undefined;
    const reasons: string[] = [];

    // ── Move guardrails ──

    // Rule 1: If bot has a deliverable load and a reachable delivery city,
    // prefer the move toward that city (don't skip movement)
    if (!selectedMove && allMoveOptions.length > 0) {
      const deliveryMoveIdx = allMoveOptions.findIndex(o =>
        o.feasible && o.payment && o.payment > 0
      );
      if (deliveryMoveIdx >= 0) {
        moveOverridden = true;
        correctedMoveIndex = deliveryMoveIdx;
        reasons.push("Guardrail: skipped movement but deliverable load reachable");
      }
    }

    // ── Build guardrails ──

    // Rule 2: Never go bankrupt — check build cost against remaining money
    // Account for track usage fees from the selected move
    const moveCost = selectedMove?.estimatedCost ?? 0;
    const remainingAfterMove = snapshot.bot.money - moveCost;

    if (selectedBuild.estimatedCost &&
        remainingAfterMove - selectedBuild.estimatedCost < 5) {
      const safeOptions = allBuildOptions
        .map((o, i) => ({ o, i }))
        .filter(({ o }) =>
          !o.estimatedCost || remainingAfterMove - o.estimatedCost >= 5
        );
      if (safeOptions.length > 0) {
        buildOverridden = true;
        correctedBuildIndex = safeOptions[0].i;
        reasons.push(
          `Guardrail: build would leave ${remainingAfterMove - selectedBuild.estimatedCost!}M (below 5M minimum)`
        );
      }
    }

    // Rule 3: Never discard hand when Phase 0 already handled deliveries
    // (DiscardHand ends the turn — it would skip the build phase entirely)
    if (selectedBuild.action === AIActionType.DiscardHand) {
      // Only allow discard if no other build option scores well
      const nonDiscardIdx = allBuildOptions.findIndex(o =>
        o.feasible && o.action === AIActionType.BuildTrack
      );
      if (nonDiscardIdx >= 0) {
        buildOverridden = true;
        correctedBuildIndex = nonDiscardIdx;
        reasons.push("Guardrail: DiscardHand overridden — buildable track available");
      }
    }

    return {
      moveOverridden,
      buildOverridden,
      correctedMoveIndex,
      correctedBuildIndex,
      reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    };
  }
}
```

---

## 5. GameStateSerializer

This is the most important module — it bridges the gap between the structured game state and what the LLM can reason about.

### 5.1 Design Principles

1. **Pre-compute everything numerical.** The LLM picks strategy; it never calculates distances, costs, or routes.
2. **Use city names, not coordinates.** "Lyon→Zurich→Milano" not "row 32 col 24 → row 38 col 28."
3. **Include decision-relevant context only.** Skip database IDs, pixel positions, segment arrays, and raw hex data.
4. **Scale information to skill level.** Easy gets a simplified view. Hard gets full competitive intelligence.

### 5.2 Track Network Summary

Don't dump raw segments. Summarize the network as a human would describe it:

```typescript
function summarizeTrackNetwork(snapshot: WorldSnapshot): string {
  // Extract connected cities from track segments
  const cities = extractConnectedCities(snapshot.trackNetwork);
  const totalMileposts = countMileposts(snapshot.trackNetwork);

  // Identify corridors (sequences of connected cities)
  const corridors = identifyCorridors(cities);

  // Example output:
  // "22 mileposts covering Lyon–Paris, Lyon–Marseille, Marseille–Bordeaux"
  return `${totalMileposts} mileposts covering ${corridors.join(', ')}`;
}
```

### 5.3 Option Description Format

Each option needs enough detail for strategic reasoning but not implementation detail:

```typescript
function describeOption(option: FeasibleOption, snapshot: WorldSnapshot): string {
  switch (option.type) {
    case 'DeliverLoad':
      const route = describeRoute(option.path);
      const turns = estimateTurns(option.path, snapshot.trainSpeed);
      const newTrack = option.newTrackCost > 0
        ? ` Needs ${option.newTrackCost}M new track.`
        : ' Uses existing track.';
      const fees = option.trackUsageFees > 0
        ? ` Uses opponent track (${option.trackUsageFees}M fee).`
        : '';
      return `DELIVER: ${option.loadType} to ${option.destinationCity} for ${option.payout}M. `
           + `Route: ${route} (${option.distance} mileposts, ${turns} turns).${newTrack}${fees}`;

    case 'BuildTrack':
      const nearMajor = option.nearbyMajorCities.length > 0
        ? ` Passes near major city ${option.nearbyMajorCities.join(', ')}.`
        : '';
      const enables = option.enabledDeliveries.length > 0
        ? ` Enables: ${option.enabledDeliveries.map(d => `${d.load}→${d.city} (${d.payout}M)`).join(', ')}.`
        : '';
      return `BUILD TRACK: ${option.routeDescription} (${option.distance} mileposts, ${option.cost}M).`
           + `${nearMajor}${enables}`;

    case 'BuildTowardMajorCity':
      return `BUILD TOWARD MAJOR CITY: Extend toward ${option.targetCity} `
           + `(${option.cost}M this turn, ~${option.totalEstimatedCost}M total). `
           + `Connects ${snapshot.connectedMajorCities + 1}th major.`;

    case 'UpgradeTrain':
      return `UPGRADE TRAIN: ${option.targetTrain} (speed ${option.newSpeed}, `
           + `capacity ${option.newCapacity}) for ${option.cost}M. `
           + `No track building this turn.`;

    case 'PickupAndDeliver':
      const iv = ((option.payout - option.newTrackCost) / option.estimatedTurns).toFixed(1);
      return `PICKUP AND DELIVER: ${option.loadType} at ${option.supplyCity} `
           + `(${option.newTrackCost > 0 ? `needs ${option.newTrackCost}M new track` : 'reachable'}), `
           + `deliver to ${option.destinationCity} (${option.payout}M). `
           + `Income velocity: ${iv}M/turn over ~${option.estimatedTurns} turns.`;

    case 'DiscardHand':
      return `DISCARD HAND: Draw 3 new demand cards. Ends turn immediately.`;

    case 'PassTurn':
      return `PASS TURN: Do nothing.`;
  }
}
```

### 5.4 Demand Card Format

```text
Card 1: Wine → Vienna (48M, 12 mileposts, existing track) | Steel → Barcelona (52M, needs 14M track) | Cheese → London (28M, needs ferry)
```

Include the pre-computed reachability and cost for each demand so the LLM can compare them meaningfully.

### 5.5 Opponent Section (Medium/Hard Only)

**Medium** — position and cash only:
```text
OPPONENTS:
- Alice: 95M, at Berlin
- Bot-3: 72M, at Essen
```

**Hard** — full competitive intelligence:
```text
OPPONENTS:
- Alice: 95M, Fast Freight, at Berlin, carrying Coal. Track covers Hamburg–Berlin–Wien.
  Recent builds: extending toward Praha (east). Likely targeting eastern European deliveries.
- Bot-3: 72M, Freight, at Essen, carrying Steel. Track covers Essen–Ruhr–Frankfurt.
  Recent builds: extending toward Stuttgart (south).
```

The "Recent builds" and "Likely targeting" lines are computed by analyzing the last 3 turns of track segments each opponent built and projecting the direction.

---

## 6. Strategy Inspector Integration

The LLM approach *improves* the Strategy Inspector because the reasoning is natural language instead of inscrutable score tables.

### 6.1 What the Strategy Inspector Shows

**Before (heuristic Scorer):**
```
Selected: DeliverWine (score: 87)
  Immediate income: 0.8 × 1.0 × 0.95 = 0.76
  Income/milepost: 0.6 × 1.5 × 0.82 = 0.74
  Network expansion: 0.4 × 0.7 × 0.30 = 0.08
  ... (9 more dimensions)
```

**After (LLM Strategy Brain):**
```
Selected: Deliver Wine to Vienna for 48M (option 0)

Reasoning: "I'm delivering the Wine I picked up in Bordeaux because
Vienna is reachable on my existing track extension through Zurich, and
48M gets me to 135M — well on track for mid-game. The backbone from
Lyon through Zurich is exactly where I want to be building anyway."

Next 2-3 turns: "Build a spur from Innsbruck toward Wien to connect
my 3rd major city while I look for eastern European demands."

Model: claude-sonnet-4-20250514 | Latency: 1.4s | Tokens: 847 in / 94 out
Guardrail override: No
```

### 6.2 StrategyAudit Object

```typescript
interface LLMStrategyAudit {
  turnNumber: number;
  gamePhase: string;
  archetype: string;
  skillLevel: string;

  // Snapshot summary (same as before)
  position: string;
  money: number;
  trainType: string;
  loads: string[];
  connectedMajorCities: number;

  // LLM-specific fields
  model: string;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
  reasoning: string;
  planHorizon: string;

  // Options
  feasibleOptions: { index: number; type: string; description: string }[];
  selectedOptionIndex: number;
  infeasibleOptions: { type: string; reason: string }[];

  // Guardrail
  wasGuardrailOverride: boolean;
  guardrailReason?: string;

  // Fallback
  wasFallback: boolean;
  fallbackReason?: string;
}
```
