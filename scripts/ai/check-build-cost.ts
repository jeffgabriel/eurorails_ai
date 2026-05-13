#!/usr/bin/env npx ts-node
import { estimatePathCost, estimateHopDistance } from '../../src/server/services/ai/MapTopology';
import * as fs from 'fs';
import * as path from 'path';

interface RawGridPoint {
  Id: string;
  Type: string;
  Name: string | null;
  GridX: number;
  GridY: number;
}

const raw: RawGridPoint[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../configuration/gridPoints.json'), 'utf8'),
);

function findCity(name: string): { row: number; col: number; type: string }[] {
  return raw
    .filter(g => g.Name === name)
    .map(g => ({ row: g.GridY, col: g.GridX, type: g.Type }));
}

function leg(fromName: string, toName: string) {
  const fromPts = findCity(fromName);
  const toPts = findCity(toName);
  if (!fromPts.length || !toPts.length) {
    console.log(`MISSING ${fromName} or ${toName}`);
    return;
  }
  let bestCost = Infinity;
  let bestPair: any = null;
  for (const f of fromPts) {
    for (const t of toPts) {
      const c = estimatePathCost(f.row, f.col, t.row, t.col);
      if (c > 0 && c < bestCost) {
        bestCost = c;
        bestPair = { f, t };
      }
    }
  }
  const hop = bestPair ? estimateHopDistance(bestPair.f.row, bestPair.f.col, bestPair.t.row, bestPair.t.col) : -1;
  console.log(`${fromName.padEnd(12)} → ${toName.padEnd(12)}: cost=${String(bestCost).padStart(3)}M  hops=${hop}`);
  return { bestCost, hop };
}

console.log('=== Land routes to Arhus from continental Europe ===');
leg('Hamburg', 'Arhus');
leg('Bremen', 'Arhus');
leg('Berlin', 'Arhus');
leg('Ruhr', 'Arhus');
leg('Holland', 'Arhus');
console.log('\n=== Reference: ferry-required Scandinavia cities ===');
leg('Hamburg', 'Kobenhavn');
leg('Hamburg', 'Stockholm');
leg('Hamburg', 'Oslo');
leg('Hamburg', 'Goteborg');
console.log('\n=== From within Scandinavia ===');
leg('Arhus', 'Kobenhavn');
leg('Arhus', 'Goteborg');
