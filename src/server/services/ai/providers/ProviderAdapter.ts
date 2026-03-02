import { ProviderResponse } from '../../../../shared/types/GameTypes';

export interface ThinkingConfig {
  type: string;
  effort?: string;
}

export interface ProviderAdapter {
  chat(request: {
    model: string;
    maxTokens: number;
    temperature: number;
    systemPrompt: string;
    userPrompt: string;
    outputSchema?: object;
    thinking?: ThinkingConfig;
    timeoutMs?: number;
  }): Promise<ProviderResponse>;
}
