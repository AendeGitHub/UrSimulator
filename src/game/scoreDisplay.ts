// The scores during a match: all of them as they change; only the points earned on the field with
// what they were for (FOULS and cards wait for the results); or nothing until the results.
// Settings → Interface picks it; in an online room the admin picks it for everyone.

export type ScoreDisplay = 'live' | 'earned' | 'end';
export const SCORE_DISPLAYS: ScoreDisplay[] = ['live', 'earned', 'end'];

/** A saved or received choice, with anything else back to the whole score. */
export const cleanScoreDisplay = (value: unknown): ScoreDisplay => (SCORE_DISPLAYS.includes(value as ScoreDisplay) ? value as ScoreDisplay : 'live');
