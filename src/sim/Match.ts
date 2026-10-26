// Match flow (AUTO → transition → TELEOP), human players entering NECTAR, and the live score.

import { ballInRect, clearOfWalls, footprint, polygonOverlapsRect, rectCenter, type Zones } from '../field/zones';
import { emptyScore, scoreField, type AllianceScore } from '../game/scoring';
import type { Alliance } from '../robot/robotConfig';
import type { BallSim } from './BallSim';
import type { HiveSim } from './HiveSim';
import type { RobotSim } from './RobotSim';

export type Period = 'practice' | 'auto' | 'transition' | 'teleop' | 'post';
export const PERIODS: Period[] = ['practice', 'auto', 'transition', 'teleop', 'post'];

/** Seconds (manual 10.4) */
export const DURATION = { auto: 30, transition: 8, teleop: 120 };
/** With this much TELEOP left, flowers open and all NECTAR may be entered (G410, G426). */
export const ENDGAME = 60;
const FINAL_WARNING = 20;
/** Time for balls to settle before the final score (manual 10.5: "come to rest"). */
const SETTLE = 3;
const HUMAN_PLAYER_INTERVAL = 1.5;

export interface MatchEvents {
  toast(text: string): void;
  finished(): void;
}

const ALLIANCES: Alliance[] = ['red', 'blue'];

/** The field timer as drivers see it (2:30 → 2:00 in AUTO, 0:08 transition, 2:00 → 0:00 TELEOP). */
export function matchClock(period: Period, time: number): { text: string; label: string; urgent: boolean } {
  const fmt = (s: number) => {
    const t = Math.max(0, Math.ceil(s));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  switch (period) {
    case 'practice':
      return { text: '∞', label: 'Тренировка', urgent: false };
    case 'auto':
      return { text: fmt(DURATION.auto + DURATION.teleop - time), label: 'АВТОНОМ', urgent: false };
    case 'transition':
      return { text: fmt(DURATION.transition - time), label: 'Переход', urgent: true };
    case 'teleop': {
      const left = DURATION.teleop - time;
      return { text: fmt(left), label: left <= ENDGAME ? 'TELEOP · цветы открыты' : 'TELEOP', urgent: left <= FINAL_WARNING };
    }
    case 'post':
      return { text: '0:00', label: 'Конец матча', urgent: false };
  }
}

/** Drivers may control robots (not between periods or after the match). */
export const robotsEnabled = (period: Period) => period === 'practice' || period === 'auto' || period === 'teleop';

export class Match {
  period: Period = 'practice';
  /** Seconds since the current period started */
  time = 0;
  readonly score: Record<Alliance, AllianceScore> = { red: emptyScore(), blue: emptyScore() };
  private settle = 0;
  private finished = false;
  private readonly humanTimer: Record<Alliance, number> = { red: 0, blue: 0 };
  /** G408 violations per robot this match */
  private readonly violations = new Map<string, number>();
  private scoreTimer = 0;

  constructor(
    private readonly balls: BallSim,
    private readonly hives: Record<Alliance, HiveSim>,
    private readonly robots: () => RobotSim[],
    private readonly zones: Zones,
    private readonly events: MatchEvents,
  ) {
    for (const a of ALLIANCES) {
      hives[a].onTip = hive => {
        const s = this.score[hive.alliance];
        if (this.period === 'auto' || this.period === 'transition') s.autoTips++;
        else s.teleopTips++;
        this.events.toast(`${hive.alliance === 'red' ? 'Красный' : 'Синий'} улей перевернулся! +20`);
      };
    }
  }

  start(period: 'practice' | 'auto'): void {
    this.period = period;
    this.time = 0;
    this.settle = 0;
    this.finished = false;
    for (const a of ALLIANCES) {
      Object.assign(this.score[a], emptyScore());
      this.humanTimer[a] = 0;
    }
    this.violations.clear();
    this.updateFieldScore();
  }

  get isMatch(): boolean {
    return this.period !== 'practice';
  }

  get robotEnabled(): boolean {
    return robotsEnabled(this.period);
  }

  /** Seconds left in TELEOP (Infinity outside it). */
  get teleopLeft(): number {
    return this.period === 'teleop' ? DURATION.teleop - this.time : this.period === 'post' ? 0 : Infinity;
  }

  step(dt: number): void {
    if (this.finished) return; // final score is frozen
    this.time += dt;
    switch (this.period) {
      case 'auto':
        if (this.time >= DURATION.auto) {
          this.scoreAutoRobots();
          this.next('transition');
          this.events.toast('Автоном окончен. Водители, берите геймпады!');
        }
        break;
      case 'transition':
        if (this.time >= DURATION.transition) {
          this.next('teleop');
          this.events.toast('TELEOP!');
        }
        break;
      case 'teleop': {
        const before = DURATION.teleop - (this.time - dt);
        const left = DURATION.teleop - this.time;
        if (before > ENDGAME && left <= ENDGAME) this.events.toast('Осталась минута: цветы открыты, весь NECTAR в игре');
        if (before > FINAL_WARNING && left <= FINAL_WARNING) this.events.toast('Последние 20 секунд!');
        if (left <= 0) this.next('post');
        break;
      }
      case 'post':
        this.settle += dt;
        if (this.settle >= SETTLE) {
          this.updateFieldScore();
          this.finished = true;
          this.events.finished();
          return;
        }
        break;
    }
    if (this.robotEnabled) this.runHumanPlayers(dt);

    this.scoreTimer -= dt;
    if (this.scoreTimer <= 0) {
      this.scoreTimer = 0.25;
      this.updateFieldScore();
    }
  }

  /**
   * G408 (opponent's NECTAR): the manual gives a verbal warning, and a yellow card when it is
   * repeated. A third time in one match is treated as strategic: red card, disqualification.
   */
  recordViolation(robot: RobotSim, rule: 'G408'): void {
    if (this.finished) return;
    const n = (this.violations.get(robot.slot) ?? 0) + 1;
    this.violations.set(robot.slot, n);
    const s = this.score[robot.alliance];
    const who = robot.slot.replace('red', 'Red ').replace('blue', 'Blue ');
    if (n === 1) {
      s.warnings++;
      this.events.toast(`⚠️ ${who}: предупреждение — нельзя брать NECTAR соперника (${rule})`);
    } else if (n === 2) {
      s.yellowCards++;
      this.events.toast(`🟨 ${who}: жёлтая карточка — снова NECTAR соперника (${rule})`);
    } else if (n === 3) {
      s.redCards++;
      this.events.toast(`🟥 ${who}: красная карточка — дисквалификация, 0 очков (${rule})`);
    }
  }

  /** Jumps to a period (used by tests and debugging). */
  next(period: Period): void {
    this.period = period;
    this.time = 0;
  }

  private corners(r: RobotSim): [number, number][] {
    const [x, , z] = r.position;
    return footprint(x, z, r.yaw, r.cfg.length, r.cfg.width);
  }

  private scoreAutoRobots(): void {
    for (const r of this.robots()) {
      const s = this.score[r.alliance];
      const corners = this.corners(r);
      if (clearOfWalls(corners, this.zones.wall)) s.leave++;
      if (polygonOverlapsRect(corners, this.zones.loading[r.alliance])) s.autoPark++;
    }
  }

  /** Field-position scores, plus end-of-match PARK, recomputed live. */
  private updateFieldScore(): void {
    const free = this.balls.all.filter(b => b.state === 'field');
    const snapshot = free.map(b => ({ kind: b.kind, color: b.color, pos: this.balls.position(b), radius: b.radius }));
    const cells = { red: this.hives.red.ballsInUpCell(this.balls).length, blue: this.hives.blue.ballsInUpCell(this.balls).length };
    const field = scoreField(snapshot, this.zones, cells);
    for (const a of ALLIANCES) {
      this.score[a].field = field[a];
      this.score[a].teleopPark = this.isMatch
        ? this.robots().filter(r => r.alliance === a && polygonOverlapsRect(this.corners(r), this.zones.loading[a])).length
        : 0;
    }
  }

  /** NECTAR the human player may have entered so far (G426). */
  private nectarAllowed(a: Alliance): number {
    return this.hives[a].tips + (this.teleopLeft <= ENDGAME ? Infinity : 0);
  }

  private runHumanPlayers(dt: number): void {
    for (const a of ALLIANCES) {
      this.humanTimer[a] -= dt;
      if (this.humanTimer[a] > 0) continue;
      const staged = this.balls.all.filter(b => b.kind === 'nectar' && b.color === a && b.state === 'staged');
      const entered = this.balls.all.filter(b => b.kind === 'nectar' && b.color === a && b.homeState === 'staged').length - staged.length;
      if (!staged.length || entered >= this.nectarAllowed(a)) continue;
      // G427: NECTAR must touch the tiles in the loading zone first, so not while a robot is in it.
      const zone = this.zones.loading[a];
      if (this.robots().some(r => polygonOverlapsRect(this.corners(r), zone))) continue;
      const spot = this.freeLoadingSpot(a);
      if (!spot) continue;
      this.balls.release(staged[0], [spot[0], 0.3, spot[1]], [0, 0, 0]);
      this.humanTimer[a] = HUMAN_PLAYER_INTERVAL;
    }
  }

  /** The human player lines NECTAR up along the loading zone; returns a spot with no ball on it. */
  private freeLoadingSpot(a: Alliance): [number, number] | null {
    const zone = this.zones.loading[a];
    const [x, zc] = rectCenter(zone);
    const occupied = this.balls.all
      .filter(b => b.state === 'field' && ballInRect(this.balls.position(b), b.radius, zone))
      .map(b => this.balls.position(b));
    for (const dz of [0, -0.1, 0.1, -0.2, 0.2]) {
      const z = zc + dz;
      if (occupied.every(p => Math.hypot(p[0] - x, p[2] - z) > 0.095)) return [x, z];
    }
    return null;
  }
}
