/**
 * LoggingProviderAdapter — Decorator that intercepts ProviderAdapter.chat()
 * calls to log LLM transcripts to a separate NDJSON file.
 *
 * Best-effort logging: never alters error propagation or response data.
 */

import { randomUUID } from 'crypto';
import { ProviderResponse } from '../../../shared/types/GameTypes';
import { ProviderAdapter, ThinkingConfig } from './providers/ProviderAdapter';
import { appendLLMCall, LLMTranscriptEntry } from './LLMTranscriptLogger';

interface LoggingContext {
  gameId: string;
  playerId: string;
  playerName?: string;
  turn: number;
  caller: string;
  method: string;
}

export interface LLMCallSummary {
  callId: string;
  caller: string;
  latencyMs: number;
  tokenUsage?: { input: number; output: number };
}

export class LoggingProviderAdapter implements ProviderAdapter {
  private inner: ProviderAdapter;
  private context: LoggingContext | null = null;
  private callIds: string[] = [];
  private callSummaries: LLMCallSummary[] = [];

  constructor(inner: ProviderAdapter) {
    this.inner = inner;
  }

  setContext(ctx: LoggingContext): void {
    this.context = ctx;
  }

  getCallIds(): string[] {
    return [...this.callIds];
  }

  getCallSummaries(): LLMCallSummary[] {
    return [...this.callSummaries];
  }

  resetCallIds(): void {
    this.callIds = [];
    this.callSummaries = [];
  }

  async chat(request: {
    model: string;
    maxTokens: number;
    temperature: number;
    systemPrompt: string;
    userPrompt: string;
    outputSchema?: object;
    thinking?: ThinkingConfig;
    effort?: string;
    timeoutMs?: number;
  }): Promise<ProviderResponse> {
    const callId = randomUUID();
    this.callIds.push(callId);
    const startMs = Date.now();
    let responseText = '';
    let status: LLMTranscriptEntry['status'] = 'success';
    let errorMsg: string | undefined;
    let tokenUsage: { input: number; output: number } | undefined;

    try {
      const result = await this.inner.chat(request);
      responseText = result.text;
      tokenUsage = result.usage;
      return result;
    } catch (err) {
      status = 'error';
      errorMsg = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const latencyMs = Date.now() - startMs;
      this.callSummaries.push({
        callId,
        caller: this.context?.caller ?? 'unknown',
        latencyMs,
        tokenUsage,
      });
      if (this.context) {
        const entry: LLMTranscriptEntry = {
          callId,
          gameId: this.context.gameId,
          playerId: this.context.playerId,
          playerName: this.context.playerName,
          turn: this.context.turn,
          timestamp: new Date().toISOString(),
          caller: this.context.caller,
          method: this.context.method,
          model: request.model,
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          responseText,
          status,
          error: errorMsg,
          latencyMs,
          tokenUsage,
          attemptNumber: 1,
          totalAttempts: 1,
        };
        appendLLMCall(this.context.gameId, entry);
      }
    }
  }
}
