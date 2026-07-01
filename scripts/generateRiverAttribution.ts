/**
 * One-time script to generate river attribution data for waterCrossings.json.
 *
 * Uses rivers.json seed edges + simultaneous multi-source BFS to assign
 * each of the 503 river crossing edges in waterCrossings.json to named river(s).
 *
 * Usage: npx ts-node scripts/generateRiverAttribution.ts [--write]
 *   Without --write: prints summary only (dry run)
 *   With --write: updates configuration/waterCrossings.json in place
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Load data ─────────────────────────────────────────────────────────────────

const riversPath = path.resolve(__dirname, '../configuration/rivers.json');
const crossingsPath = path.resolve(__dirname, '../configuration/waterCrossings.json');

interface RiverEdgeData {
  Start: { Row: number; Col: number };
  End: { Row: number; Col: number };
}
interface RiverData {
  Name: string;
  Edges: RiverEdgeData[];
}

const rivers: RiverData[] = JSON.parse(fs.readFileSync(riversPath, 'utf8'));
const crossings = JSON.parse(fs.readFileSync(crossingsPath, 'utf8'));
const allRiverEdges = new Set<string>(crossings.riverEdges as string[]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function canonicalEdgeKey(r1: number, c1: number, r2: number, c2: number): string {
  const a = `${r1},${c1}`;
  const b = `${r2},${c2}`;
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

// ── Build adjacency graph ─────────────────────────────────────────────────────

// milepost -> set of edge keys touching that milepost
const milespostToEdges = new Map<string, Set<string>>();
for (const edgeKey of allRiverEdges) {
  const [a, b] = edgeKey.split('|');
  if (!milespostToEdges.has(a)) milespostToEdges.set(a, new Set());
  if (!milespostToEdges.has(b)) milespostToEdges.set(b, new Set());
  milespostToEdges.get(a)!.add(edgeKey);
  milespostToEdges.get(b)!.add(edgeKey);
}

// ── Extract valid seed edges per river ────────────────────────────────────────

// rivers.json End coords are transposed (Row/Col swapped) — same fix as trackService.ts
const riverSeeds = new Map<string, Set<string>>();
for (const river of rivers) {
  const seeds = new Set<string>();
  for (const edge of river.Edges) {
    const endRow = edge.End.Col; // swap
    const endCol = edge.End.Row; // swap
    const key = canonicalEdgeKey(edge.Start.Row, edge.Start.Col, endRow, endCol);
    if (allRiverEdges.has(key)) {
      seeds.add(key);
    }
  }
  riverSeeds.set(river.Name, seeds);
}

// ── Manual overrides for orphan clusters ──────────────────────────────────────

// These edges form disconnected components that no rivers.json seed can reach.
// Identified by geographic analysis of the hex map.
const manualOverrides: Record<string, string[]> = {
  // Vistula lower course (rows 19-26, cols 59-63) — disconnected from seeds
  Vistula: [
    '19,52|20,53', '20,52|20,53', '20,60|20,61', '20,60|21,60',
    '21,59|21,60', '21,60|22,60', '22,59|23,59', '22,60|22,61',
    '22,60|23,59', '22,60|23,60', '23,58|23,59', '23,59|24,59',
    '24,59|24,60', '24,60|25,59', '24,60|25,60', '24,61|25,60',
    '25,60|25,61', '25,61|26,61', '25,61|26,62', '25,62|26,62',
    '25,62|26,63', '25,63|26,63',
  ],
  // Danube delta area
  Donau: [
    '12,21|12,22', '12,22|12,23', '12,22|13,22',
  ],
  // Southern isolated edges
  Guadalquivir: [
    '51,42|51,43', '51,42|52,43',
  ],
  Ebro: [
    '57,50|57,51',
  ],
};

// ── Missing edges to add to waterCrossings.json ───────────────────────────────

// Edges that cross a river but weren't detected by the original waterCrossings
// generation. These get added to both riverEdges[] and riverAttribution.
const missingEdges: Record<string, string[]> = {
  Ebro: [
    '46,20|46,21',
    '46,21|47,20',
  ],
};

// ── Post-BFS attribution corrections ──────────────────────────────────────────

// Edges where BFS confluence tolerance incorrectly assigns a river.
// Format: { edgeKey: { remove: [rivers to remove], add: [rivers to add] } }
const attributionCorrections: Record<string, { remove?: string[]; add?: string[] }> = {
  // These edges are Meuse-only, not Rhein — the Meuse/Rhein confluence zone
  // was over-extended by BFS tolerance
  '25,38|26,38': { remove: ['Rhein'] },
  '25,38|26,39': { remove: ['Rhein'] },
  '25,38|25,39': { remove: ['Rhein'] },
  '24,39|25,39': { remove: ['Rhein'] },
  '24,39|24,40': { remove: ['Rhein'] },
  '23,39|24,40': { remove: ['Rhein'] },

  // These edges are Loire-only, not Rhône — the Loire/Rhône confluence is
  // at 39,33; edges from 35,32 down to 38,33->39,32 are Loire's course
  '35,32|36,32': { remove: ['Rhône'] },
  '36,32|36,33': { remove: ['Rhône'] },
  '36,33|37,32': { remove: ['Rhône'] },
  '37,32|37,33': { remove: ['Rhône'] },
  '37,32|38,33': { remove: ['Rhône'] },
  '38,32|38,33': { remove: ['Rhône'] },
  '38,33|39,32': { remove: ['Rhône'] },
};

// ── Inject missing edges into working set ─────────────────────────────────────

const addedToRiverEdges: string[] = [];
for (const [, edges] of Object.entries(missingEdges)) {
  for (const edge of edges) {
    if (!allRiverEdges.has(edge)) {
      allRiverEdges.add(edge);
      addedToRiverEdges.push(edge);
      // Also update adjacency graph
      const [a, b] = edge.split('|');
      if (!milespostToEdges.has(a)) milespostToEdges.set(a, new Set());
      if (!milespostToEdges.has(b)) milespostToEdges.set(b, new Set());
      milespostToEdges.get(a)!.add(edge);
      milespostToEdges.get(b)!.add(edge);
    }
  }
}

// ── Simultaneous multi-source BFS ─────────────────────────────────────────────

// edgeKey -> set of river names that claim it
const edgeAttribution = new Map<string, Set<string>>();
// edgeKey -> BFS layer at which each river first reached it
const edgeLayerByRiver = new Map<string, Map<string, number>>(); // edge -> (river -> layer)

// Confluence tolerance: if a second river reaches an edge within this many
// BFS layers of the first, it also gets attribution
const CONFLUENCE_TOLERANCE = 2;

// Initialize seeds
const frontiers = new Map<string, Set<string>>(); // river -> current frontier edges
for (const [riverName, seeds] of riverSeeds) {
  const frontier = new Set<string>();
  for (const seed of seeds) {
    if (!edgeAttribution.has(seed)) {
      edgeAttribution.set(seed, new Set());
      edgeLayerByRiver.set(seed, new Map());
    }
    edgeAttribution.get(seed)!.add(riverName);
    edgeLayerByRiver.get(seed)!.set(riverName, 0);
    frontier.add(seed);
  }
  frontiers.set(riverName, frontier);
}

// Apply missing edges as layer-0 seeds (already added to allRiverEdges above)
for (const [riverName, edges] of Object.entries(missingEdges)) {
  if (!frontiers.has(riverName)) {
    frontiers.set(riverName, new Set());
  }
  for (const edge of edges) {
    if (!allRiverEdges.has(edge)) continue;
    if (!edgeAttribution.has(edge)) {
      edgeAttribution.set(edge, new Set());
      edgeLayerByRiver.set(edge, new Map());
    }
    edgeAttribution.get(edge)!.add(riverName);
    edgeLayerByRiver.get(edge)!.set(riverName, 0);
    frontiers.get(riverName)!.add(edge);
  }
}

// Apply manual overrides as layer-0 seeds
for (const [riverName, edges] of Object.entries(manualOverrides)) {
  if (!frontiers.has(riverName)) {
    frontiers.set(riverName, new Set());
  }
  for (const edge of edges) {
    if (!allRiverEdges.has(edge)) continue;
    if (!edgeAttribution.has(edge)) {
      edgeAttribution.set(edge, new Set());
      edgeLayerByRiver.set(edge, new Map());
    }
    edgeAttribution.get(edge)!.add(riverName);
    edgeLayerByRiver.get(edge)!.set(riverName, 0);
    frontiers.get(riverName)!.add(edge);
  }
}

// BFS loop — all rivers expand one layer at a time
let layer = 0;
let anyProgress = true;
while (anyProgress) {
  anyProgress = false;
  layer++;

  const newFrontiers = new Map<string, Set<string>>();
  for (const riverName of frontiers.keys()) {
    newFrontiers.set(riverName, new Set());
  }

  for (const [riverName, frontier] of frontiers) {
    for (const currentEdge of frontier) {
      const [a, b] = currentEdge.split('|');
      for (const mp of [a, b]) {
        const neighbors = milespostToEdges.get(mp);
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          if (!edgeLayerByRiver.has(neighbor)) {
            edgeLayerByRiver.set(neighbor, new Map());
          }
          if (!edgeAttribution.has(neighbor)) {
            edgeAttribution.set(neighbor, new Set());
          }

          const layerMap = edgeLayerByRiver.get(neighbor)!;

          if (layerMap.has(riverName)) {
            // This river already reached this edge
            continue;
          }

          // Check if another river already claimed it
          const existingRivers = edgeAttribution.get(neighbor)!;
          if (existingRivers.size === 0) {
            // First river to reach — claim it
            existingRivers.add(riverName);
            layerMap.set(riverName, layer);
            newFrontiers.get(riverName)!.add(neighbor);
            anyProgress = true;
          } else {
            // Another river already here — check confluence tolerance
            let earliestLayer = Infinity;
            for (const [, l] of layerMap) {
              if (l < earliestLayer) earliestLayer = l;
            }
            if (layer - earliestLayer <= CONFLUENCE_TOLERANCE) {
              existingRivers.add(riverName);
              layerMap.set(riverName, layer);
              newFrontiers.get(riverName)!.add(neighbor);
              anyProgress = true;
            }
            // Otherwise: too far behind, don't add attribution
          }
        }
      }
    }
  }

  // Swap frontiers
  for (const [riverName, newFrontier] of newFrontiers) {
    frontiers.set(riverName, newFrontier);
  }
}

// ── Apply post-BFS corrections ────────────────────────────────────────────────

for (const [edgeKey, correction] of Object.entries(attributionCorrections)) {
  const rivers = edgeAttribution.get(edgeKey);
  if (!rivers) continue;
  if (correction.remove) {
    for (const r of correction.remove) rivers.delete(r);
  }
  if (correction.add) {
    for (const r of correction.add) rivers.add(r);
  }
}

// ── Build output ──────────────────────────────────────────────────────────────

const riverAttribution: Record<string, string[]> = {};
for (const [edge, rivers] of edgeAttribution) {
  riverAttribution[edge] = Array.from(rivers).sort();
}

// ── Summary ───────────────────────────────────────────────────────────────────

const assigned = edgeAttribution.size;
const unassigned = allRiverEdges.size - assigned;

console.log(`\n=== River Attribution Summary ===`);
console.log(`Total river edges: ${allRiverEdges.size}`);
console.log(`Assigned: ${assigned}`);
console.log(`Unassigned: ${unassigned}`);

if (unassigned > 0) {
  const unassignedEdges: string[] = [];
  for (const edge of allRiverEdges) {
    if (!edgeAttribution.has(edge) || edgeAttribution.get(edge)!.size === 0) {
      unassignedEdges.push(edge);
    }
  }
  console.log(`Unassigned edges: ${unassignedEdges.join(', ')}`);
}

// Per-river counts
const riverCounts = new Map<string, number>();
for (const [, rivers] of edgeAttribution) {
  for (const r of rivers) {
    riverCounts.set(r, (riverCounts.get(r) || 0) + 1);
  }
}
console.log(`\nPer-river edge counts:`);
for (const [river, count] of [...riverCounts].sort((a, b) => b[1] - a[1])) {
  const seedCount = riverSeeds.get(river)?.size ?? 0;
  console.log(`  ${river}: ${count} edges (${seedCount} seeds)`);
}

// Multi-attributed edges
const multiEdges: string[] = [];
for (const [edge, rivers] of edgeAttribution) {
  if (rivers.size > 1) multiEdges.push(`${edge} -> [${Array.from(rivers).join(', ')}]`);
}
console.log(`\nMulti-attributed edges (confluences): ${multiEdges.length}`);
for (const m of multiEdges.slice(0, 20)) {
  console.log(`  ${m}`);
}
if (multiEdges.length > 20) {
  console.log(`  ... and ${multiEdges.length - 20} more`);
}

// Verify the 3 known Rhein crossings from the test
console.log(`\n=== Verification: Known Rhein crossings ===`);
const testEdges = ['22,40|23,39', '24,39|25,39', '27,41|27,42'];
for (const e of testEdges) {
  const rivers = edgeAttribution.get(e);
  const hasRhein = rivers?.has('Rhein') ?? false;
  console.log(`  ${e}: ${rivers ? `[${Array.from(rivers).join(', ')}]` : 'UNASSIGNED'} — Rhein: ${hasRhein ? 'YES' : 'MISSING'}`);
}

// ── Write ─────────────────────────────────────────────────────────────────────

if (process.argv.includes('--write')) {
  crossings.version = 2;
  // Add any missing edges to the flat riverEdges array
  for (const edge of addedToRiverEdges) {
    if (!crossings.riverEdges.includes(edge)) {
      crossings.riverEdges.push(edge);
    }
  }
  crossings.riverAttribution = riverAttribution;
  fs.writeFileSync(crossingsPath, JSON.stringify(crossings, null, 2) + '\n');
  console.log(`\nWrote updated waterCrossings.json (added ${addedToRiverEdges.length} missing edges to riverEdges[])`);
} else {
  console.log(`\nDry run — pass --write to update waterCrossings.json`);
}
