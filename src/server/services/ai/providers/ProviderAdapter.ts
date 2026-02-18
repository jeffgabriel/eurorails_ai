import { ProviderResponse } from '../../../../shared/types/GameTypes';

export interface ProviderAdapter {
  chat(request: {
    model: string;
    maxTokens: number;
    temperature: number;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<ProviderResponse>;
}
