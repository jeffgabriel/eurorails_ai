#!/usr/bin/env python3
"""
sweep-spatial-prune.py

Reads the JSONL dump from spatial-prune-analysis.ts (--dump mode) and sweeps
(OCPT, PRUNE_MAX_TURNS, PRUNE_MAX_BUILD_M) parameter combinations to find the
configuration that maximizes top-1 win rate vs LLM choice.

Win rate metric: (top1_better + top1_match + top1_tied) / total.
We additionally report mean and median score deltas, and the count of
strict losses (worse cases).
"""
import json
import sys
from itertools import product

DUMP_FILE = sys.argv[1] if len(sys.argv) > 1 else '/tmp/spatial-dump.jsonl'

def evaluate(turns, ocpt, prune_max_turns, prune_max_build):
    """Return (matches, better, worse, tied, mean_delta, median_delta) for a parameter combo."""
    matches = better = worse = tied = 0
    deltas = []
    for t in turns:
        # Filter candidates per the prune thresholds, then pick top-1 by score
        survivors = [
            c for c in t['candidates']
            if c['feasible']
            and c['estTurns'] <= prune_max_turns
            and c['estBuild'] <= prune_max_build
        ]
        if not survivors:
            continue
        for c in survivors:
            net = c['payout'] - c['simBuild']
            c['_score'] = net - ocpt * c['simTurns']
        survivors.sort(key=lambda x: x['_score'], reverse=True)
        top1 = survivors[0]
        bot = t['botChoice']
        bot_score = None
        if bot and bot['feasible']:
            bot_score = (bot['payout'] - bot['simBuild']) - ocpt * bot['simTurns']

        same_choice = bot is not None and top1['rowKey'] == bot['rowKey']
        if same_choice:
            matches += 1
            deltas.append(0)
        elif bot_score is None:
            tied += 1  # bot's choice unmappable; we count as tie (no comparison)
            deltas.append(0)
        else:
            d = top1['_score'] - bot_score
            deltas.append(d)
            if d > 0: better += 1
            elif d < 0: worse += 1
            else: tied += 1
    n = matches + better + worse + tied
    mean_d = sum(deltas) / n if n else 0
    sorted_d = sorted(deltas)
    median_d = sorted_d[n // 2] if n else 0
    return matches, better, worse, tied, mean_d, median_d, n

def main():
    turns = []
    with open(DUMP_FILE) as f:
        for line in f:
            turns.append(json.loads(line))
    print(f"Loaded {len(turns)} turn dumps")

    ocpt_grid = [3, 4, 5, 6, 7, 8, 9, 10, 12, 15]
    prune_turns_grid = [10, 12, 15, 18]
    prune_build_grid = [80, 100, 130, 160]

    print(f"\nSweeping {len(ocpt_grid)} × {len(prune_turns_grid)} × {len(prune_build_grid)} = {len(ocpt_grid) * len(prune_turns_grid) * len(prune_build_grid)} combos\n")

    rows = []
    for ocpt, pt, pb in product(ocpt_grid, prune_turns_grid, prune_build_grid):
        m, bt, w, ti, md, medd, n = evaluate(turns, ocpt, pt, pb)
        win_rate = (m + bt + ti) / n if n else 0
        rows.append({
            'ocpt': ocpt, 'pt': pt, 'pb': pb,
            'match': m, 'better': bt, 'worse': w, 'tied': ti, 'n': n,
            'win_rate': win_rate, 'mean_d': md, 'median_d': medd,
            'better_pct': bt / n if n else 0,
            'worse_pct': w / n if n else 0,
        })

    # Sort by primary criterion: max win_rate (= 1 − worse_rate), tiebreak by max better_pct, then mean_d
    rows.sort(key=lambda r: (-r['win_rate'], -r['better_pct'], -r['mean_d']))

    # Print top 15 configurations
    print(f"## Top 15 configurations by win rate (= match+better+tied) / n\n")
    print(f"| OCPT | PR_T | PR_B | n | match | better | worse | tied | win% | better% | mean_d | med_d |")
    print(f"|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows[:15]:
        print(f"| {r['ocpt']} | {r['pt']} | {r['pb']} | {r['n']} | {r['match']} | {r['better']} | {r['worse']} | {r['tied']} | {100*r['win_rate']:.1f}% | {100*r['better_pct']:.1f}% | {r['mean_d']:.2f} | {r['median_d']:.1f} |")

    # Also show: at OCPT=5 (current default), what prune thresholds maximize win rate?
    print(f"\n## At OCPT=5 (current default): best prune thresholds\n")
    print(f"| PR_T | PR_B | better% | worse% | mean_d | median_d |")
    print(f"|---:|---:|---:|---:|---:|---:|")
    for r in [r for r in rows if r['ocpt'] == 5][:10]:
        print(f"| {r['pt']} | {r['pb']} | {100*r['better_pct']:.1f}% | {100*r['worse_pct']:.1f}% | {r['mean_d']:.2f} | {r['median_d']:.1f} |")

    # Hold prune at the current (PR_T=18, PR_B=130) and sweep OCPT
    print(f"\n## At PR_T=18, PR_B=130 (current default): OCPT sensitivity\n")
    print(f"| OCPT | match | better | worse | tied | better% | worse% | mean_d | median_d |")
    print(f"|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in sorted([r for r in rows if r['pt'] == 18 and r['pb'] == 130], key=lambda x: x['ocpt']):
        print(f"| {r['ocpt']} | {r['match']} | {r['better']} | {r['worse']} | {r['tied']} | {100*r['better_pct']:.1f}% | {100*r['worse_pct']:.1f}% | {r['mean_d']:.2f} | {r['median_d']:.1f} |")

    # Identify the lowest-strict-loss configurations
    print(f"\n## Configurations with FEWEST strict losses\n")
    rows_by_worse = sorted(rows, key=lambda r: (r['worse'], -r['better_pct'], -r['mean_d']))
    print(f"| OCPT | PR_T | PR_B | match | better | worse | tied | better% | mean_d |")
    print(f"|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows_by_worse[:10]:
        print(f"| {r['ocpt']} | {r['pt']} | {r['pb']} | {r['match']} | {r['better']} | {r['worse']} | {r['tied']} | {100*r['better_pct']:.1f}% | {r['mean_d']:.2f} |")

    # And max mean delta (strongest gains where it differs)
    print(f"\n## Configurations with HIGHEST mean delta\n")
    rows_by_mean = sorted(rows, key=lambda r: -r['mean_d'])
    print(f"| OCPT | PR_T | PR_B | match | better | worse | tied | better% | mean_d | median_d |")
    print(f"|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows_by_mean[:10]:
        print(f"| {r['ocpt']} | {r['pt']} | {r['pb']} | {r['match']} | {r['better']} | {r['worse']} | {r['tied']} | {100*r['better_pct']:.1f}% | {r['mean_d']:.2f} | {r['median_d']:.1f} |")

if __name__ == '__main__':
    main()
