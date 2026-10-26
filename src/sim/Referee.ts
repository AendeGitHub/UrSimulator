// Automatic referee for the BIOBUZZ game rules the simulation can judge by itself (manual 11.4).
//
// FOULS give points to the other alliance: MINOR FOUL 5, MAJOR FOUL 20 (section 10.6). Cards
// follow section 10.6.1: a VERBAL WARNING has no effect on the score; a second YELLOW CARD turns
// into a RED CARD, and a RED CARD disqualifies (0 match points).
//
// Judged here:
//   G402  no interference with the opponent's AUTO (their scoring elements or their robot on
//         their side of the field): MAJOR FOUL per MATCH
//   G405  a scoring element ejected out of the field: MAJOR FOUL per element
//   G408  controlling the opponent's NECTAR: VERBAL WARNING, YELLOW CARD per MATCH if repeated
//   G410  NECTAR launched into a FLOWER before the last minute: MAJOR FOUL per NECTAR
//   G417  ramming the HIVE frame: VERBAL WARNING, MAJOR FOUL and YELLOW CARD per MATCH if
//         strategic (fast or repeated)
//   G421  pinning an opponent for more than 3 s: MAJOR FOUL, plus one more every 3 s
//
// Cannot be broken in the simulation, so nothing to judge: G403 / G404 (robots are disabled
// between periods and after the match), G407 (the robot holds at most 4), G409 (the intake only
// reaches the floor, so nothing is caught in the air), G418 (no intake from a FLOWER), G426–G428
// (the human player follows the rules). The rest are about people, inspection or a referee's
// judgement of intent.

import type { AllianceScore } from '../game/scoring';
import type { Alliance } from '../robot/robotConfig';
import { SLOT_NAMES, slotAlliance, type Slot } from './types';

export type RuleId = 'G402' | 'G405' | 'G408' | 'G410' | 'G417' | 'G421';

export const FOUL_POINTS = { minor: 5, major: 20 };
/** Two moderate hits on the HIVE frame within this time count as ramming it on purpose, s */
const HIVE_HIT_WINDOW = 10;

const opponent = (a: Alliance): Alliance => (a === 'red' ? 'blue' : 'red');

export class Referee {
  /** Times each robot broke each rule this match, keyed "slot|rule" */
  private readonly counts = new Map<string, number>();
  private readonly perMatch = new Set<string>();
  private readonly yellow = new Set<Slot>();
  private readonly red = new Set<Slot>();
  private readonly hiveHits = new Map<Slot, number[]>();

  constructor(private readonly score: Record<Alliance, AllianceScore>) {}

  reset(): void {
    this.counts.clear();
    this.perMatch.clear();
    this.yellow.clear();
    this.red.clear();
    this.hiveHits.clear();
  }

  /** G402: MAJOR FOUL per MATCH. */
  autoInterference(slot: Slot): void {
    if (this.once(slot, 'G402')) this.foul(slot, 'G402', 'major');
  }

  /** G405: MAJOR FOUL per scoring element. */
  ejectedOutOfField(slot: Slot): void {
    this.foul(slot, 'G405', 'major');
  }

  /** G408: VERBAL WARNING; YELLOW CARD per MATCH when it keeps happening (STRATEGIC). */
  opponentNectar(slot: Slot): void {
    if (this.repeated(slot, 'G408') && this.once(slot, 'G408')) this.yellowCard(slot, 'G408');
  }

  /** G410: MAJOR FOUL per NECTAR. */
  earlyFlowerNectar(slot: Slot): void {
    this.foul(slot, 'G410', 'major');
  }

  /**
   * G417: a hit on the HIVE frame at `speed` m/s at match time `time`. A fast hit, or a second
   * moderate one within 10 s, is ramming (STRATEGIC): MAJOR FOUL and YELLOW CARD per MATCH.
   */
  hiveFrameHit(slot: Slot, speed: number, time: number): void {
    const hits = (this.hiveHits.get(slot) ?? []).filter(t => time - t < HIVE_HIT_WINDOW);
    hits.push(time);
    this.hiveHits.set(slot, hits);
    const strategic = speed > 1.5 || hits.length >= 2;
    if (!strategic) return this.warning(slot, 'G417');
    if (this.once(slot, 'G417')) {
      this.foul(slot, 'G417', 'major');
      this.yellowCard(slot, 'G417');
    }
  }

  /** G421: MAJOR FOUL when a PIN passes 3 s, and another for every 3 s more. */
  pin(slot: Slot): void {
    this.foul(slot, 'G421', 'major');
  }

  /** MINOR or MAJOR FOUL: the points go to the opposing alliance. */
  private foul(slot: Slot, rule: RuleId, kind: 'minor' | 'major'): void {
    const a = slotAlliance(slot);
    if (kind === 'major') this.score[a].majorFouls++;
    else this.score[a].minorFouls++;
    this.score[opponent(a)].foulPoints += FOUL_POINTS[kind];
    this.call(slot, rule, kind === 'major' ? 'MAJOR FOUL' : 'MINOR FOUL');
  }

  private warning(slot: Slot, rule: RuleId): void {
    this.score[slotAlliance(slot)].warnings++;
    this.call(slot, rule, 'предупреждение');
  }

  /** A second YELLOW CARD is a RED CARD (10.6.1). */
  private yellowCard(slot: Slot, rule: RuleId): void {
    if (this.red.has(slot)) return;
    if (this.yellow.has(slot)) return this.redCard(slot, rule);
    this.yellow.add(slot);
    this.score[slotAlliance(slot)].yellowCards++;
    this.call(slot, rule, 'жёлтая карточка');
  }

  private redCard(slot: Slot, rule: RuleId): void {
    this.red.add(slot);
    this.score[slotAlliance(slot)].redCards++;
    this.call(slot, rule, 'красная карточка');
  }

  /** VERBAL WARNING the first time; true when the robot does it again. */
  private repeated(slot: Slot, rule: RuleId): boolean {
    const key = `${slot}|${rule}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n === 1) this.warning(slot, rule);
    return n > 1;
  }

  /** "per MATCH": true only the first time for this robot and rule. */
  private once(slot: Slot, rule: RuleId): boolean {
    const key = `${slot}|${rule}`;
    if (this.perMatch.has(key)) return false;
    this.perMatch.add(key);
    return true;
  }

  /** Every call is listed on the results board. */
  private call(slot: Slot, rule: RuleId, what: string): void {
    this.score[slotAlliance(slot)].calls.push(`${rule} · ${what} · ${SLOT_NAMES[slot]}`);
  }
}
