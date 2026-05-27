# JIRA-257 — Suppress Guardrail G1 force-delivery when the candidate is blocked by an active pickup/delivery restriction (technical)

Companion to `jira-257-guardrailG1BypassesPickupDeliveryRestriction-behavioral.md`.

## Defect locus

`src/server/services/ai/GuardrailEnforcer.ts:70-86` — the first block of `checkPlan`, "Guardrail 1: Force DELIVER when canDeliver has opportunities". This block fires whenever `context.canDeliver.length > 0 && planType !== AIActionType.DeliverLoad` and returns immediately with `overridden: true`.

The `isPickupDeliveryBlocked` predicate is correctly imported at line 36 and IS consulted inside the same `checkPlan` method at line 318 (the new BE-006 `PICKUP_DELIVERY_RESTRICTION_VIOLATION` gate). But that gate runs after G1, so when G1 short-circuits, the predicate-aware gate never runs against the forced plan.

## Fix shape

Inside the G1 block, after selecting `best = GuardrailEnforcer.bestDelivery(context)`, consult `isPickupDeliveryBlocked` against the candidate's delivery city BEFORE constructing the override. If the candidate is blocked, fall through to the next guardrail (do not return the override).

Approximate change at GuardrailEnforcer.ts:70-86:

```ts
if (context.canDeliver.length > 0 && planType !== AIActionType.DeliverLoad) {
  const best = GuardrailEnforcer.bestDelivery(context);
  const activeEffects = snapshot.activeEffects ?? [];
  const pickupDeliveryRestrictions = activeEffects.flatMap(e => e.restrictions.pickupDelivery);
  const cityKey = getCityMilepointKey(best.deliveryCity);
  const blocked = cityKey !== null && isPickupDeliveryBlocked(pickupDeliveryRestrictions, cityKey);
  if (blocked) {
    console.warn(`[Guardrail 1] Suppressing forced DELIVER: ${best.loadType} at ${best.deliveryCity} — blocked by active pickup/delivery restriction (event card)`);
    // fall through — do NOT return the override
  } else {
    console.warn(`[Guardrail 1] Forced DELIVER: ${best.loadType} at ${best.deliveryCity} for ${best.payout}M (LLM chose ${planType})`);
    return {
      plan: { type: AIActionType.DeliverLoad, load: best.loadType, city: best.deliveryCity, cardId: best.cardIndex, payout: best.payout },
      overridden: true,
      reason: `Forced DELIVER: ${best.loadType} at ${best.deliveryCity} for ${best.payout}M (LLM chose ${planType})`,
    };
  }
}
```

If `context.canDeliver` includes multiple options, the current `bestDelivery` picks the highest-payout one and stops; the simple fix above suppresses the override even if a non-blocked alternative exists in `canDeliver`. A second-pass refinement (out of scope for this ticket; file follow-up if needed): iterate `context.canDeliver` and return the highest-payout option whose delivery city is NOT blocked. The first-pass fix matches the immediate observed bug and avoids over-engineering until a real case appears where the bot has multiple simultaneous deliverable opportunities at differently-restricted cities.

## Acceptance from behavioral

- **AC1** — Unit test on `GuardrailEnforcer.checkPlan`: fixture with `context.canDeliver = [{ loadType: 'Marble', deliveryCity: 'London', payout: 31, cardIndex: 43 }]`, `plan = { type: PassTurn }`, `snapshot.activeEffects = [{ restrictions: { pickupDelivery: [{ kind: 'COASTAL_STRIKE_CITIES', cityMilepointKeys: [getCityMilepointKey('London')!] }] } }]`. Assert: returned plan has `overridden: false` (or `undefined`) and the original PassTurn passes through.
- **AC2** — Unit test, same fixture but `snapshot.activeEffects = []`. Assert: G1 fires, returns `{ type: DeliverLoad, load: 'Marble', city: 'London' }`, `overridden: true`. Regression guard.
- **AC3** — Unit test, two `canDeliver` entries — Marble@London (blocked by Strike) and Iron@Bremen (not blocked). Assert: with the simple first-pass fix, the override is suppressed (because `bestDelivery` picks London first). Document this in the test as a known limitation; the multi-candidate iteration is a follow-up.
- **AC4** — Integration: replay Haiku T31 of game `182bfd36-3d3d-46ef-9c1d-0c87373b983f` via the existing replay harness (if available) or a synthetic snapshot matching that turn. Assert: turn entry has `action: PassTurn`, no `guardrailOverride`, no `rejectionReason`.

## Validation hooks to inspect during fix

- The new console.warn line `[Guardrail 1] Suppressing forced DELIVER` should appear in stderr for Haiku turns 31–33 and s1 turns 31–32 when replaying.
- Turn entries for those turns should NOT have `rejectionReason: { code: 'COASTAL_STRIKE_BLOCKED', ... }` after the fix.
- `cash` should still be 31 (Haiku) and 20 (s1) — the bot couldn't actually earn anything during the Strike — but the bot now legally passes/builds rather than spamming a rejected delivery.

## Not in scope

- Multi-candidate iteration through `context.canDeliver` to find a non-blocked alternative. First-pass fix suppresses-or-allows the top candidate only.
- Equivalent suppression logic for other guardrails (broke-and-stuck DiscardHand, etc.) — those don't construct forced deliveries.
- Changes to `isPickupDeliveryBlocked` itself, or to `WorldSnapshotService` population of `activeEffects`. The predicate and snapshot are correct; only the guardrail caller is missing the check.
- Generalizing to a `checkPredicatesBeforeOverride` helper. The G1 block is the only override that constructs a DeliverLoad; no other overrides need this gate.

## Relationship to existing JIRAs

- **JIRA-256 / BE-006**: this is a fix-up to the BE-006 integration. The fix is small and self-contained; no spec change to JIRA-256 needed beyond adding a note that the G1 override path also needs the predicate consultation.
