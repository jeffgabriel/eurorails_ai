/**
 * Shared helper for stripping markdown code fences from LLM responses.
 * Used by AnthropicAdapter and ClaudeAgentSdkAdapter to normalise output.
 */

/**
 * Strip markdown code fences from a string.
 * Handles ` ```json\n...\n``` ` and ` ```\n...\n``` ` formats.
 * Returns the input unchanged if no fences are detected.
 */
export function stripCodeFences(text: string): string {
  // Strip leading fence: ```json\n or ```\n
  const stripped = text.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '');
  return stripped;
}
