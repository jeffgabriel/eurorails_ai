import type { WorldSnapshot } from './GameTypes';

export interface BotTurnSummary {
  action: string;
  reasoning: string;
  cost: number;
  segmentsBuilt: number;
  loadsPickedUp?: Array<{ loadType: string; city: string }>;
  loadsDelivered?: Array<{ loadType: string; city: string; payment: number }>;
  milepostsMoved?: number;
  compositionTrace?: object;
  demandRanking?: object[];
}

export interface WhisperMetadata {
  gamePhase: string;
  botSkillLevel: string;
  botProvider: string;
  botModel: string;
  botMoney: number;
  botTrainType: string;
  botConnectedCities: number;
}

export interface WhisperSubmitPayload {
  gameId: string;
  turnNumber: number;
  botPlayerId: string;
  advice: string;
  botTurnSummary: BotTurnSummary;
}

export interface WhisperRecord {
  id: string;
  gameId: string;
  turnNumber: number;
  botPlayerId: string;
  humanPlayerId: string;
  advice: string;
  botDecision: BotTurnSummary;
  gameStateSnapshot: WorldSnapshot;
  metadata: WhisperMetadata;
  createdAt: string;
}
