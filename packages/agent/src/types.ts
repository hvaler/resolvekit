/**
 * The buying agent's view of a model: one turn in, function calls (and maybe text) out, with the provider's usage.
 * Provider details stay in the adapters (models.ts); the engine only sees these types.
 */

export type JsonSchema = Record<string, unknown>;

export interface FunctionDecl {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ModelCall {
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Provider-specific data that must travel back with this call in later turns (Gemini's thoughtSignature).
   * Opaque: the engine copies it into the model transcript entry as is and never shows it.
   */
  providerData?: unknown;
}

export type TranscriptEntry =
  | { role: 'user'; text: string }
  | { role: 'model'; call: { name: string; arguments: Record<string, unknown> }; providerData?: unknown }
  | { role: 'tool'; name: string; result: unknown };

/** Tokens of one call as the provider reported them; zeros and reported false when it said nothing. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reported: boolean;
}

export interface ModelTurn {
  calls: ModelCall[];
  text: string | null;
  usage: Usage;
}

export interface TurnRequest {
  system: string;
  transcript: TranscriptEntry[];
  tools: FunctionDecl[];
  maxOutputTokens: number;
}

export interface AgentModel {
  readonly provider: 'gemini' | 'groq';
  readonly model: string;
  /** One model call. Throws ModelError (from @resolvekit/analyst) on failure. */
  turn(req: TurnRequest): Promise<ModelTurn>;
}

/** Rough count before sending: ceil(chars / 4) of system + transcript JSON + tools JSON. */
export function estimateTokens(req: TurnRequest): number {
  return Math.ceil((req.system.length + JSON.stringify(req.transcript).length + JSON.stringify(req.tools).length) / 4);
}
