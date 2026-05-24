#!/usr/bin/env python3
"""
Investigation: enumerate pair candidates for S3's t46 snapshot in game
ad976b38, *with all valid supply cities* for multi-supply loads.

Tests the hypothesis: pair Bauxite+Labor never won at t46 because Labor's
supply was pre-resolved to Sarajevo (causing the pair to be pruned by the
12-turn cap), but pair-with-Labor-via-Zagreb would survive and beat the
single Bauxite under JIRA-229's aggregate ranking.

This script approximates the planner's cheapPrune + score using the same
hex-distance and HOP_AVG_COST_M constants. It does NOT replay the full
simulateTrip (which would require the bot's existing track segments),
so build cost estimates are upper-bound (treats all hops as new track).
That's the same approximation cheapPrune itself uses.
"""
import json, math
from itertools import permutations
from pathlib import Path

ROOT = Path('/Users/mattheweverard/Code/jeff/bot-fixes')

# ── Constants matching DeterministicTripPlanner ───────────────────────
HOP_AVG_COST_M = 1.3
PRUNE_MAX_TURNS = 12
PRUNE_MAX_BUILD_M = 130
FAST_FREIGHT_SPEED = 12
FAST_FREIGHT_CAP = 2
OCPT_MID = 4  # phase reported at t46 was 'mid'

# ── Load configs ───────────────────────────────────────────────────────
with open(ROOT / 'configuration/gridPoints.json') as f:
    grid = json.load(f)

# Map city name -> list of (row, col); multiple coords per major city outpost
city_coords = {}
for p in grid:
    name = p.get('Name')
    if name:
        city_coords.setdefault(name, []).append((p['GridY'], p['GridX']))

with open(ROOT / 'configuration/load_cities.json') as f:
    lc = json.load(f)

# load_cities.json is wrapped; flatten to load -> [cities]
load_supplies = {}
def walk(node):
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, list) and v and isinstance(v[0], str):
                load_supplies[k] = v
            else:
                walk(v)
    elif isinstance(node, list):
        for x in node:
            walk(x)
walk(lc)

# ── Hex distance (matches MapTopology.hexDistance) ─────────────────────
def hex_distance(r1, c1, r2, c2):
    x1 = c1 - (r1 // 2 if r1 >= 0 else -((-r1+1)//2))
    z1 = r1
    y1 = -x1 - z1
    x2 = c2 - (r2 // 2 if r2 >= 0 else -((-r2+1)//2))
    z2 = r2
    y2 = -x2 - z2
    return max(abs(x1-x2), abs(y1-y2), abs(z1-z2))

def nearest_city_coord(city, from_pos):
    coords = city_coords.get(city)
    if not coords:
        return None
    return min(coords, key=lambda c: hex_distance(from_pos[0], from_pos[1], c[0], c[1]))

# ── Snapshot reconstruction for S3 at t46 (game ad976b38) ─────────────
# From the log: S3 just delivered Machinery at Budapest, cash=45M, train=fast_freight.
# Demand cards in hand at t46:
demand_hand = [
    {'load':'Bauxite',   'delivery':'Berlin',    'payout':14, 'cardIndex':1},
    {'load':'Potatoes',  'delivery':'Zurich',    'payout':20, 'cardIndex':2},
    {'load':'Beer',      'delivery':'Sevilla',   'payout':48, 'cardIndex':3},
    {'load':'Wine',      'delivery':'London',    'payout':16, 'cardIndex':4},
    {'load':'Chocolate', 'delivery':'Lisboa',    'payout':40, 'cardIndex':5},
    {'load':'Hops',      'delivery':'Frankfurt', 'payout':21, 'cardIndex':6},
    {'load':'Labor',     'delivery':'Holland',   'payout':23, 'cardIndex':7},
    {'load':'Oranges',   'delivery':'Marseille', 'payout':18, 'cardIndex':8},
    {'load':'Fish',      'delivery':'Stuttgart', 'payout':33, 'cardIndex':9},
]
bot_pos = nearest_city_coord('Budapest', (0,0))

# ── Cheap-prune estimate for a route (list of stops with city names) ──
def cheap_prune(start_pos, stop_cities, speed=FAST_FREIGHT_SPEED):
    total_hops = 0
    cur = start_pos
    for city in stop_cities:
        dest = nearest_city_coord(city, cur)
        if dest is None:
            return {'keep': False, 'turns': 999, 'build': 999}
        total_hops += hex_distance(cur[0], cur[1], dest[0], dest[1])
        cur = dest
    est_turns = max(1, math.ceil(total_hops / speed))
    est_build = total_hops * HOP_AVG_COST_M
    keep = est_turns <= PRUNE_MAX_TURNS and est_build <= PRUNE_MAX_BUILD_M
    return {'keep': keep, 'turns': est_turns, 'build': est_build, 'hops': total_hops, 'end': cur}

# ── Enumerate pair candidates for Bauxite + Labor across supply variants ──
bauxite = next(d for d in demand_hand if d['load'] == 'Bauxite')
labor   = next(d for d in demand_hand if d['load'] == 'Labor')

# Bauxite supply: only Budapest produces Bauxite per the config
bauxite_supplies = load_supplies.get('Bauxite', [])
labor_supplies   = load_supplies.get('Labor', [])
print(f"Bauxite supply cities: {bauxite_supplies}")
print(f"Labor supply cities:   {labor_supplies}")
print()

def build_pair_variants(a_pick, a_del, b_pick, b_del):
    """Four geometric variants for a fresh+fresh pair (cap≥2)."""
    return {
        'AB':        [a_pick, b_pick, a_del, b_del],
        'BA':        [a_pick, b_pick, b_del, a_del],
        'A-then-B':  [a_pick, a_del, b_pick, b_del],
        'B-then-A':  [b_pick, b_del, a_pick, a_del],
    }

# Also enumerate the single-Bauxite baseline
single_bauxite_route = [bauxite_supplies[0], bauxite['delivery']]  # Budapest, Berlin
single_b_result = cheap_prune(bot_pos, single_bauxite_route)
single_b_payout = bauxite['payout']
single_b_build = single_b_result['build']
single_b_net = single_b_payout - single_b_build
single_b_score_per_trip = single_b_net - OCPT_MID * single_b_result['turns']
single_b_velocity = single_b_net / max(single_b_result['turns'], 1)
print(f"=== Baseline: single Bauxite Budapest→Berlin ===")
print(f"  turns={single_b_result['turns']}, build={single_b_build:.1f}M, hops={single_b_result['hops']}, NET={single_b_net:.1f}M")
print(f"  per-trip score = {single_b_score_per_trip:.1f}")
print(f"  standalone velocity = {single_b_velocity:.2f} M/turn")
print()

# Single Labor baseline for each supply (used as follow-up estimate)
print(f"=== Single Labor candidates (by supply) ===")
labor_singles = {}
for sup in labor_supplies:
    res = cheap_prune(bot_pos, [sup, labor['delivery']])
    net = labor['payout'] - res['build']
    labor_singles[sup] = {**res, 'net': net, 'velocity': net / max(res['turns'], 1)}
    flag = '✓' if res['keep'] else '✗ PRUNED'
    print(f"  via {sup:10s}: turns={res['turns']:2d}, build={res['build']:5.1f}M, NET={net:5.1f}M, velocity={labor_singles[sup]['velocity']:.2f} M/turn  {flag}")
print()

# Pair Bauxite + Labor across supply variants
print(f"=== Pair Bauxite + Labor candidates (by Labor supply, by variant) ===")
results = []
for labor_sup in labor_supplies:
    variants = build_pair_variants(
        a_pick=bauxite_supplies[0],   # 'Budapest'
        a_del=bauxite['delivery'],    # 'Berlin'
        b_pick=labor_sup,
        b_del=labor['delivery'],      # 'Holland'
    )
    for vname, stops in variants.items():
        res = cheap_prune(bot_pos, stops)
        payout = bauxite['payout'] + labor['payout']
        net = payout - res['build']
        # Per-trip score
        per_trip_score = net - OCPT_MID * res['turns']
        # Standalone velocity (NET / turns)
        velocity = net / max(res['turns'], 1)
        results.append({
            'labor_sup': labor_sup,
            'variant': vname,
            'stops': stops,
            **res,
            'net': net,
            'per_trip_score': per_trip_score,
            'velocity': velocity,
        })

# Print sorted by velocity (best-first), but show all
print(f"{'Labor sup':<10} {'Variant':<10} {'Turns':>5} {'Build':>6} {'NET':>5} {'Velocity':>9} {'Status':<15}")
for r in sorted(results, key=lambda x: -x['velocity']):
    flag = 'SURVIVES' if r['keep'] else 'PRUNED'
    print(f"{r['labor_sup']:<10} {r['variant']:<10} {r['turns']:>5} {r['build']:>5.1f}M {r['net']:>4.1f}M {r['velocity']:>7.2f} M/t  {flag}")

# Surviving best pair
surviving = [r for r in results if r['keep']]
if surviving:
    best = max(surviving, key=lambda r: r['velocity'])
    print(f"\nBest surviving pair: Labor via {best['labor_sup']}, variant {best['variant']}")
    print(f"  stops: {' → '.join(best['stops'])}")
    print(f"  turns={best['turns']}, NET={best['net']:.1f}M, standalone velocity={best['velocity']:.2f} M/turn")
else:
    print(f"\nNO pair survived prune.")

# JIRA-229 aggregate comparison
print(f"\n=== Aggregate comparison: single Bauxite + best-follow-up  vs  best surviving pair ===")
# For single Bauxite: best follow-up is a second single from Berlin.
# Try each remaining card (excluding Bauxite) as the next-best single.
others = [d for d in demand_hand if d['cardIndex'] != bauxite['cardIndex']]
berlin_pos = nearest_city_coord('Berlin', bot_pos)
best_followup_for_bauxite = None
for d in others:
    if d['load'] in load_supplies:
        for sup in load_supplies[d['load']]:
            fres = cheap_prune(berlin_pos, [sup, d['delivery']])
            if not fres['keep']:
                continue
            fnet = d['payout'] - fres['build']
            # Aggregate: (n1 + n2) / (t1 + emptyLeg + t2)
            # emptyLeg from Berlin to follow-up first stop (sup) already in cheap_prune
            # but cheap_prune treats sup as first stop, so its hops to sup *is* the empty leg
            # Wait — for single Bauxite, the candidate ends at Berlin. The follow-up's
            # cheap_prune was run starting from Berlin already, so its turn count
            # includes the Berlin→sup empty leg. Total turns = 2 (Bauxite) + fres.turns.
            agg_net = single_b_net + fnet
            agg_turns = single_b_result['turns'] + fres['turns']
            agg_velocity = agg_net / agg_turns
            if best_followup_for_bauxite is None or agg_velocity > best_followup_for_bauxite['agg_velocity']:
                best_followup_for_bauxite = {
                    'follow_load': d['load'], 'follow_sup': sup, 'follow_del': d['delivery'],
                    'follow_turns': fres['turns'], 'follow_net': fnet,
                    'agg_velocity': agg_velocity, 'agg_net': agg_net, 'agg_turns': agg_turns,
                }
    else:
        # Bauxite-style single-supply load
        sup = bauxite_supplies[0] if d['load']=='Bauxite' else d['load']  # fallback
        # skip if no supply known

if best_followup_for_bauxite:
    bf = best_followup_for_bauxite
    print(f"Single Bauxite + best follow-up: {bf['follow_load']} via {bf['follow_sup']} → {bf['follow_del']}")
    print(f"  aggregate: ({single_b_net:.1f}M + {bf['follow_net']:.1f}M) / ({single_b_result['turns']} + {bf['follow_turns']} turns) = {bf['agg_velocity']:.2f} M/turn")

# For best surviving pair: best follow-up from the pair's end city
if surviving:
    best_pair = max(surviving, key=lambda r: r['velocity'])
    pair_end = best_pair['end']
    pair_used_cards = {bauxite['cardIndex'], labor['cardIndex']}
    best_followup_for_pair = None
    for d in [x for x in demand_hand if x['cardIndex'] not in pair_used_cards]:
        if d['load'] in load_supplies:
            for sup in load_supplies[d['load']]:
                fres = cheap_prune(pair_end, [sup, d['delivery']])
                if not fres['keep']:
                    continue
                fnet = d['payout'] - fres['build']
                agg_net = best_pair['net'] + fnet
                agg_turns = best_pair['turns'] + fres['turns']
                agg_velocity = agg_net / agg_turns
                if best_followup_for_pair is None or agg_velocity > best_followup_for_pair['agg_velocity']:
                    best_followup_for_pair = {
                        'follow_load': d['load'], 'follow_sup': sup, 'follow_del': d['delivery'],
                        'follow_turns': fres['turns'], 'follow_net': fnet,
                        'agg_velocity': agg_velocity, 'agg_net': agg_net, 'agg_turns': agg_turns,
                    }
    if best_followup_for_pair:
        bf = best_followup_for_pair
        print(f"\nBest pair (Labor via {best_pair['labor_sup']}, {best_pair['variant']}) + best follow-up: {bf['follow_load']} via {bf['follow_sup']} → {bf['follow_del']}")
        print(f"  aggregate: ({best_pair['net']:.1f}M + {bf['follow_net']:.1f}M) / ({best_pair['turns']} + {bf['follow_turns']} turns) = {bf['agg_velocity']:.2f} M/turn")
        # Verdict
        print(f"\n=== VERDICT ===")
        if best_followup_for_bauxite and bf['agg_velocity'] > best_followup_for_bauxite['agg_velocity']:
            print(f"Pair-via-{best_pair['labor_sup']} BEATS single Bauxite under aggregate ranking ({bf['agg_velocity']:.2f} > {best_followup_for_bauxite['agg_velocity']:.2f} M/turn)")
        else:
            print(f"Single Bauxite still wins.")

# ── scoreDemand per Labor supply variant ──────────────────────────────
# Python translation of DemandEngine.ts:262-280
# scoreDemand(payout, totalTrackCost, estimatedTurns, isAffordable=True, projectedFunds=inf)
COST_WEIGHT = 0.1

def score_demand(payout, total_track_cost, estimated_turns, is_affordable=True, projected_funds=float('inf')):
    """Mirror of DemandEngine.ts:scoreDemand (lines 262-280)."""
    income_velocity = payout / max(estimated_turns, 1)
    cost_burden = total_track_cost * COST_WEIGHT
    raw_score = income_velocity - cost_burden
    cost_penalty_factor = math.exp(-(total_track_cost - 50) / 30) if total_track_cost > 50 else 1.0
    penalized_score = (raw_score * cost_penalty_factor if raw_score >= 0
                       else raw_score / max(cost_penalty_factor, 0.01))
    if not is_affordable and total_track_cost > 0:
        shortfall = total_track_cost - max(projected_funds, 0)
        shortfall_ratio = min(shortfall / total_track_cost, 1)
        afford_penalty = max(0.05, 0.3 * (1 - shortfall_ratio))
        return (penalized_score * afford_penalty if penalized_score >= 0
                else penalized_score / max(afford_penalty, 0.01))
    return penalized_score

print(f"\n=== scoreDemand per Labor supply variant (single-trip basis) ===")
print(f"Bot cash at t46 = 45M; treating all track as new build (upper-bound cost estimate).")
print(f"{'Supply':<12} {'turns':>5} {'build':>6} {'velocity':>9} {'scoreDemand':>12}")
for sup in labor_supplies:
    res = cheap_prune(bot_pos, [sup, labor['delivery']])
    sd = score_demand(
        payout=labor['payout'],
        total_track_cost=res['build'],
        estimated_turns=res['turns'],
        is_affordable=(res['build'] <= 45),
        projected_funds=45,
    )
    print(f"{sup:<12} {res['turns']:>5} {res['build']:>5.1f}M {labor_singles[sup]['velocity']:>8.2f} M/t {sd:>12.3f}")
