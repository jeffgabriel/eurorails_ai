[BuildRouteResolver] ENABLE_BUILD_RESOLVER=false
Scanning 156 game logs...
Found 299 trip-planner entries; analyzed 299.
# Spatial-Prune + Top-1 Analysis vs LLM Choice

- Games scanned: 156
- Trip-planner entries: 299
- Analyzed (had position + hand + feasible top-1): 299

## Outcome distribution

| Outcome | Count | % |
|---|---:|---:|
| Top-1 == Bot choice | 106 | 35.5% |
| Top-1 different & better | 170 | 56.9% |
| Top-1 different & worse | 0 | 0.0% |
| Top-1 different & tied | 23 | 7.7% |

## Score deltas (top1 − bot)

- Mean: 23.65
- Median: 12.00
- Min: 0.00
- Max: 212.00

## Top 20 cases where top-1 beats bot most

| Game | Turn | Player | Position | Bot choice | Bot score | Top-1 choice | Top-1 score | Δ |
|---|---:|---|---|---|---:|---|---:|---:|
| e58c4cac | 41 | Flash | Firenze | BOT_CHOICE | -236.0 | carry:64:Marble | -24.0 | 212.0 |
| 3ef9c600 | 97 | Flash | (46,62) | BOT_CHOICE | -189.0 | carry:12:Beer | -41.0 | 148.0 |
| c4382499 | 6 | Nano | (27,53) | BOT_CHOICE | -165.0 | carry:142:Machinery | -20.0 | 145.0 |
| b1dc793c | 46 | Nano | Leipzig | BOT_CHOICE | -173.0 | s:49:Iron | -50.0 | 123.0 |
| 66e3eebc | 633 | Nano | Wien | BOT_CHOICE | -132.0 | s:74:Bauxite | -18.0 | 114.0 |
| 66e3eebc | 262 | Nano | (36,41) | BOT_CHOICE | -122.0 | s:11:Cheese | -14.0 | 108.0 |
| 189a6327 | 68 | Haiku | Budapest | BOT_CHOICE | -129.0 | p:94-Cheese+32-Wheat:BA | -22.0 | 107.0 |
| 3b19796d | 8 | Haiku | Torino | BOT_CHOICE | -156.0 | s:103:Bauxite | -51.0 | 105.0 |
| e58c4cac | 11 | Haiku | (30,47) | BOT_CHOICE | -163.0 | s:109:Oil | -60.0 | 103.0 |
| 8d8724c8 | 9 | Haiku | (33,37) | BOT_CHOICE | -173.0 | s:95:Marble | -75.0 | 98.0 |
| c5f36a97 | 51 | Nano | (19,38) | BOT_CHOICE | -86.0 | carry:86:Ham | 11.0 | 97.0 |
| 66e3eebc | 702 | Nano | Nantes | BOT_CHOICE | -85.0 | s:132:Cars | 3.0 | 88.0 |
| 66e3eebc | 387 | Flash | (16,27) | BOT_CHOICE | -65.0 | p:128-Fish+34-Fish:cBcA | 22.0 | 87.0 |
| 0c6f0fb6 | 51 | Flash | London | BOT_CHOICE | -101.0 | carry:2:Cars | -16.0 | 85.0 |
| 3c52e468 | 94 | Nano | Beograd | BOT_CHOICE | -100.0 | s:113:Beer | -15.0 | 85.0 |
| c5f36a97 | 59 | Nano | (17,30) | BOT_CHOICE | -93.0 | s:88:Cheese | -9.0 | 84.0 |
| fb3e5856 | 8 | Haiku | Wien | BOT_CHOICE | -97.0 | carry:105:Wine | -17.0 | 80.0 |
| 3ef9c600 | 52 | Flash | Wroclaw | BOT_CHOICE | -84.0 | carry:86:Ham | -5.0 | 79.0 |
| 66e3eebc | 1408 | Nano | Stuttgart | BOT_CHOICE | -99.0 | s:61:Cheese | -20.0 | 79.0 |
| 66e3eebc | 846 | Haiku | Toulouse | BOT_CHOICE | -81.0 | s:80:Oranges | -3.0 | 78.0 |

## Bottom 10 cases where top-1 is worse than bot

| Game | Turn | Player | Position | Bot choice | Bot score | Top-1 choice | Top-1 score | Δ |
|---|---:|---|---|---|---:|---|---:|---:|
| e179466e | 8 | Haiku | (41,30) | NONE | n/a | s:143:Cheese | -67.0 | 0.0 |
| e179466e | 7 | Nano | (26,57) | BOT_CHOICE | -51.0 | s:136:China | -51.0 | 0.0 |
| c4b4c111 | 34 | Nano | (34,60) | BOT_CHOICE | -71.0 | s:134:Ham | -71.0 | 0.0 |
| c4b4c111 | 32 | Nano | (34,60) | NONE | n/a | s:23:Wheat | -105.0 | 0.0 |
| c4b4c111 | 31 | Nano | (34,60) | NONE | n/a | s:23:Wheat | -105.0 | 0.0 |
| c4b4c111 | 30 | Nano | (34,60) | NONE | n/a | s:23:Wheat | -105.0 | 0.0 |
| c4b4c111 | 29 | Nano | (34,60) | NONE | n/a | s:23:Wheat | -105.0 | 0.0 |
| c4b4c111 | 28 | Nano | (34,60) | NONE | n/a | s:23:Wheat | -105.0 | 0.0 |
| c4b4c111 | 27 | Nano | (34,60) | NONE | n/a | s:23:Wheat | -105.0 | 0.0 |
| c4b4c111 | 26 | Nano | (34,60) | NONE | n/a | s:23:Wheat | -105.0 | 0.0 |

## Top-1 candidate type distribution

| Type | Count | % |
|---|---:|---:|
| Triple (3 demands) | 0 | 0.0% |
| Pair (2 demands) | 11 | 3.7% |
| Single fresh (1 demand) | 242 | 80.9% |
| Single carry (1 demand) | 46 | 15.4% |
