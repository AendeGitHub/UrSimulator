// The AI's levels a player picks: easy, medium or hard (what each one means: skill.ts). Kept apart
// from the simulation so the lobby server can check a room's level.

export type AiLevel = 'easy' | 'medium' | 'hard';
export const AI_LEVELS: AiLevel[] = ['easy', 'medium', 'hard'];
export const DEFAULT_AI_LEVEL: AiLevel = 'medium';

/** A level from settings or the network; anything else is the usual one. */
export const cleanAiLevel = (value: unknown): AiLevel => (AI_LEVELS.includes(value as AiLevel) ? (value as AiLevel) : DEFAULT_AI_LEVEL);
