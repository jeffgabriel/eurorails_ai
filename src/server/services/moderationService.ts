/**
 * Service for content moderation using Llama Guard model via Ollama HTTP API
 * Local dev: Ollama running at http://localhost:11434
 * Production: Separate container hosting Ollama
 *
 * Llama Guard 3 returns a binary "safe" or "unsafe\nS1,S2..." response
 * with no confidence score. We pass through the model's decision directly.
 */
export class ModerationService {
  private ollamaUrl: string;
  private modelName: string;
  private isInitialized: boolean = false;

  constructor() {
    this.ollamaUrl = process.env.LLAMA_GUARD_URL || 'http://localhost:11434';
    this.modelName = process.env.LLAMA_GUARD_MODEL || 'llama-guard3:1b';
  }

  /**
   * Initialize the moderation service by verifying Ollama is reachable
   * and the model is available
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      console.log(`[Moderation] Verifying Ollama model ${this.modelName} at ${this.ollamaUrl}...`);

      const response = await fetch(`${this.ollamaUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.modelName }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama returned ${response.status}: ${errorText}`);
      }

      this.isInitialized = true;
      console.log(`[Moderation] Ollama model ${this.modelName} is available`);
    } catch (error) {
      console.error('[Moderation] Failed to initialize:', error);
      throw new Error('MODERATION_INITIALIZATION_FAILED');
    }
  }

  /**
   * Check if a message is appropriate using Llama Guard via Ollama.
   * Returns { isAppropriate, violatedCategories }.
   */
  async checkMessage(
    text: string
  ): Promise<{ isAppropriate: boolean; violatedCategories: string[] }> {
    if (!this.isInitialized) {
      throw new Error('MODERATION_NOT_INITIALIZED');
    }

    // Basic validation
    if (!text || text.trim().length === 0) {
      console.log('[Moderation] Empty message rejected');
      return { isAppropriate: false, violatedCategories: [] };
    }

    try {
      const prompt = this.buildLlamaGuardPrompt(text);

      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelName,
          prompt,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API returned ${response.status}`);
      }

      const data = await response.json();
      const parsed = this.parseLlamaGuardResponse(data.response);

      if (!parsed.safe) {
        console.log('[Moderation] Message rejected:', {
          violatedCategories: parsed.categories,
        });
      }

      return {
        isAppropriate: parsed.safe,
        violatedCategories: parsed.categories,
      };
    } catch (error) {
      console.error('[Moderation] Error during moderation check:', error);
      // Fail closed: reject on error
      return { isAppropriate: false, violatedCategories: [] };
    }
  }

  /**
   * Build Llama Guard 3 prompt for content moderation
   * Following the format from: https://www.llama.com/docs/model-cards-and-prompt-formats/llama-guard-3/
   */
  private buildLlamaGuardPrompt(userMessage: string): string {
    const categories = `
<BEGIN UNSAFE CONTENT CATEGORIES>
S1: Violent Crimes.
S2: Non-Violent Crimes.
S3: Sex Crimes.
S4: Child Exploitation.
S5: Defamation.
S6: Specialized Advice.
S7: Privacy.
S8: Intellectual Property.
S9: Indiscriminate Weapons.
S10: Hate.
S11: Self-Harm.
S12: Sexual Content.
S13: Elections.
<END UNSAFE CONTENT CATEGORIES>
`;

    const conversation = `
<BEGIN CONVERSATION>

User: ${userMessage}

<END CONVERSATION>
`;

    return `<|begin_of_text|><|start_header_id|>user<|end_header_id|>

Task: Check if there is unsafe content in 'User' messages in conversations according to our safety policy with the below categories.

${categories}

${conversation}

Provide your safety assessment for ONLY THE LAST User in the above conversation:
- First line must read 'safe' or 'unsafe'.
- If unsafe, a second line must include a comma-separated list of violated categories.<|eot_id|><|start_header_id|>assistant<|end_header_id|>
`;
  }

  /**
   * Parse Llama Guard response
   * Expected format:
   * - "safe" or
   * - "unsafe\nS10" (single category, no commas)
   * - "unsafe\nS1,S2,S3" (multiple categories)
   */
  private parseLlamaGuardResponse(response: string): { safe: boolean; categories: string[] } {
    const lines = response.trim().split('\n');
    const firstLine = lines[0]?.trim().toLowerCase();

    if (firstLine === 'safe') {
      return { safe: true, categories: [] };
    } else if (firstLine === 'unsafe') {
      const categories = lines[1] ? lines[1].split(',').map(c => c.trim()) : [];
      return { safe: false, categories };
    }

    // Unparseable response - throw to trigger fail-closed in checkMessage catch block
    console.error('[Moderation] Could not parse model response:', response);
    throw new Error('Unparseable model response');
  }

  /**
   * Get health status of moderation service
   */
  getHealthStatus(): {
    initialized: boolean;
    ollamaUrl: string;
    modelName: string;
  } {
    return {
      initialized: this.isInitialized,
      ollamaUrl: this.ollamaUrl,
      modelName: this.modelName,
    };
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}

// Export singleton instance
export const moderationService = new ModerationService();
