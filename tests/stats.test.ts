import { describe, expect, it } from 'vitest';
import { Db, MemoryKv } from '../server/Kv';
import { Lobby, MIN_PRACTICE, type LobbySocket } from '../server/Lobby';
import { ELO_K, HISTORY_LIMIT, START_RATING, Stats, eloChange, isRanked, recordRun, type GameRecord } from '../server/Stats';
import { winRate } from '../src/net/accountProtocol';
import type { ServerMessage } from '../src/net/lobbyProtocol';
import { DEFAULT_RULES } from '../src/sim/Referee';

const max = { id: 'max000000000', name: 'Max', username: 'max' };
const sasha = { id: 'sasha0000000', name: 'Sasha', username: 'sasha' };
const october = new Date('2026-10-20T12:00:00Z');

const solo = (score: number, extra: Partial<GameRecord> = {}): GameRecord => ({
  type: 'solo',
  mode: 'match',
  duration: 150,
  score: { red: score, blue: 0 },
  players: [{ device: 'browser-max', account: max, alliance: 'red', robot: 'uran-v2' }],
  ai: [],
  date: october,
  ...extra,
});

/** The totals as the server kept them before it counted signed-in players' games. */
async function forgetSignedInGames(db: Db): Promise<void> {
  const saved = (await db.read<Record<string, unknown>>('totals'))!;
  delete saved.signedInGames;
  await db.write('totals', saved);
}

describe('statistics', () => {
  it('counts games by type, playtime, and every player once (account or browser)', async () => {
    const stats = new Stats(new Db(new MemoryKv()));
    await stats.record(solo(100));
    await stats.record(solo(120));
    // A guest in another browser, then the same guest after signing in: still one player.
    await stats.record({ ...solo(50), players: [{ device: 'browser-guest', name: 'Guest', alliance: 'red', robot: 'bumble-v' }] });
    await stats.record({ ...solo(60), players: [{ device: 'browser-guest', account: sasha, alliance: 'red', robot: 'bumble-v' }] });
    // Max on a new computer: still one player.
    await stats.record({ type: 'practice', mode: 'practice', duration: 300, players: [{ device: 'browser-new', account: max, alliance: 'blue', robot: 'uran-v2' }], ai: [], date: october });
    expect(await stats.totals()).toEqual({ players: 2, games: { solo: 4, duo: 0, '1v1': 0, '2v2': 0, practice: 1 }, signedInGames: 4, playtime: 900 });
  });

  it('counts signed-in players\' games from before the count once, from their histories', async () => {
    const db = new Db(new MemoryKv());
    const stats = new Stats(db);
    // Max and Sasha against each other: one game in two histories.
    await stats.record({ ...solo(0), type: '1v1', score: { red: 90, blue: 80 }, players: [{ account: max, alliance: 'red', robot: 'uran-v2' }, { account: sasha, alliance: 'blue', robot: 'bumble-v' }] });
    await stats.record(solo(100));
    await stats.record({ ...solo(50), players: [{ device: 'browser-guest', name: 'Guest', alliance: 'red', robot: 'bumble-v' }] });
    await forgetSignedInGames(db);
    await stats.backfill();
    expect((await stats.totals()).signedInGames).toBe(2);
    await stats.record(solo(90));
    await stats.backfill();
    expect((await stats.totals()).signedInGames).toBe(3);
  });

  it('takes the games a full history has forgotten from the career', async () => {
    const db = new Db(new MemoryKv());
    const stats = new Stats(db);
    await stats.record(solo(100));
    await forgetSignedInGames(db);
    const minute = (i: number) => new Date(october.getTime() + i * 60_000).toISOString();
    await db.write(`history:${max.id}`, Array.from({ length: HISTORY_LIMIT }, (_, i) => ({ date: minute(i), type: 'solo' })));
    await db.write(`career:${max.id}`, { all: { games: HISTORY_LIMIT + 50 } });
    await stats.backfill();
    expect((await stats.totals()).signedInGames).toBe(HISTORY_LIMIT + 50);
  });

  it('keeps each signed-in player\'s history and career for the season, the month and all time', async () => {
    const stats = new Stats(new Db(new MemoryKv()));
    await stats.record(solo(100));
    await stats.record({ ...solo(80), score: { red: 80, blue: 95 }, ai: ['blue'] });
    await stats.record({ ...solo(70), date: new Date('2026-11-02T00:00:00Z') });
    const history = await stats.history(max.id);
    expect(history.map(e => [e.score, e.opponent, e.result, e.ai])).toEqual([[70, null, null, false], [80, 95, 'loss', true], [100, null, null, false]]);
    const career = await stats.career(max.id);
    expect(career['2026-10']).toMatchObject({ games: 2, losses: 1, best: 100, playtime: 300 });
    expect(career['2026']).toMatchObject({ games: 3, best: 100 });
    expect(career.all.byType.solo).toBe(3);
    expect(winRate(career.all)).toBe(0);
  });

  it('puts record runs into the season and month tables of the robot and of all robots', async () => {
    const stats = new Stats(new Db(new MemoryKv()));
    expect((await stats.record(solo(100))).board).toEqual({ rank: 1, best: 100, improved: true });
    expect((await stats.record(solo(90))).board).toEqual({ rank: 1, best: 100, improved: false });
    await stats.record({ ...solo(130), players: [{ device: 'b2', name: 'Guest', alliance: 'blue', robot: 'bumble-v' }], score: { red: 0, blue: 130 } });
    const all = await stats.board('2026', 'solo', 'all');
    expect(all.map(e => [e.name, e.username, e.robot, e.score])).toEqual([['Guest', undefined, 'bumble-v', 130], ['Max', 'max', 'uran-v2', 100]]);
    expect((await stats.board('2026-10', 'solo', 'uran-v2')).map(e => e.score)).toEqual([100]);
    expect(await stats.board('2026-11', 'solo', 'all')).toEqual([]);
    // Against the AI, or practice: no table.
    expect((await stats.record({ ...solo(200), ai: ['blue'] })).board).toBeNull();
    expect((await stats.board('2026', 'solo', 'all'))[0].score).toBe(130);
  });

  it('a split screen on one alliance goes into the duo table with both robots', async () => {
    const stats = new Stats(new Db(new MemoryKv()));
    const duo: GameRecord = {
      type: 'duo',
      mode: 'match',
      duration: 150,
      score: { red: 210, blue: 0 },
      players: [{ device: 'b', account: max, alliance: 'red', robot: 'uran-v2' }, { alliance: 'red', robot: 'bumble-v' }],
      ai: [],
      date: october,
    };
    expect(recordRun(duo)).toBe('duo');
    await stats.record(duo);
    expect(await stats.board('2026', 'duo', 'all')).toEqual([expect.objectContaining({ name: 'Max', robot: 'uran-v2+bumble-v', score: 210 })]);
    // Against each other on a split screen: a game, but no table.
    expect(recordRun({ ...duo, players: [duo.players[0], { alliance: 'blue', robot: 'bumble-v' }] })).toBeNull();
  });

  it('rates ranked online matches with Elo, in the season and the month', async () => {
    const stats = new Stats(new Db(new MemoryKv()));
    const match: GameRecord = {
      type: '1v1',
      mode: 'match',
      duration: 160,
      score: { red: 150, blue: 90 },
      players: [{ account: max, alliance: 'red', robot: 'uran-v2' }, { account: sasha, alliance: 'blue', robot: 'bumble-v' }],
      ai: [],
      date: october,
    };
    expect(isRanked(match)).toBe(true);
    await stats.record(match);
    const ladder = await stats.ranked('2026');
    expect(ladder.map(e => [e.username, e.rating, e.wins, e.losses])).toEqual([['max', START_RATING + ELO_K / 2, 1, 0], ['sasha', START_RATING - ELO_K / 2, 0, 1]]);
    expect((await stats.ranked('2026-10'))[0].rating).toBe(START_RATING + ELO_K / 2);
    expect((await stats.history(max.id))[0]).toMatchObject({ result: 'win', rating: ELO_K / 2, type: '1v1' });
    // A guest or the AI in the match: not ranked.
    expect(isRanked({ ...match, players: [match.players[0], { alliance: 'blue', robot: 'bumble-v' }] })).toBe(false);
    expect(isRanked({ ...match, ai: ['blue'] })).toBe(false);
    expect(eloChange(1200, 1000, 'win')).toBeLessThan(ELO_K / 2);
    expect(eloChange(1000, 1000, 'tie')).toBe(0);
  });
});

class FakeSocket implements LobbySocket {
  readonly messages: ServerMessage[] = [];
  send(m: ServerMessage) {
    this.messages.push(m);
  }
  sendBinary() {}
}

describe('online rooms in the statistics', () => {
  function setup() {
    let now = 0;
    const games: GameRecord[] = [];
    const accounts: Record<string, typeof max> = { 'token-max-0000000000000': max, 'token-sasha-00000000000': sasha };
    const lobby = new Lobby(Math.random, { identify: async t => accounts[t] ?? null, game: g => games.push(g) }, () => now);
    const join = (name: string, token: string | null) => {
      const socket = new FakeSocket();
      const id = lobby.connect(socket)!;
      lobby.message(id, { t: 'hello', name, device: `device-${name}`, token });
      return { id, socket, send: (m: Parameters<Lobby['message']>[1]) => lobby.message(id, m) };
    };
    return { lobby, games, join, tick: (s: number) => (now += s * 1000) };
  }

  it('counts a match once, from the admin\'s result, with everyone\'s account and robot', async () => {
    const { lobby, games, join, tick } = setup();
    const admin = join('Max', 'token-max-0000000000000');
    const guest = join('Sasha', 'token-sasha-00000000000');
    await Promise.resolve();
    admin.send({ t: 'create', format: '1v1', robot: 'uran-v2', rules: DEFAULT_RULES });
    const room = (admin.socket.messages.filter(m => m.t === 'room').at(-1) as Extract<ServerMessage, { t: 'room' }>).room!;
    guest.send({ t: 'join', room: room.id, robot: 'bumble-v' });
    expect(lobby.roomOf(sasha.id)?.id).toBe(room.id);
    admin.send({ t: 'start' });
    tick(158);
    // Only the admin's result counts, and only once.
    guest.send({ t: 'result', score: { red: 0, blue: 999 } });
    admin.send({ t: 'result', score: { red: 120, blue: 140 } });
    admin.send({ t: 'result', score: { red: 120, blue: 140 } });
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      type: '1v1',
      mode: 'match',
      duration: 158,
      score: { red: 120, blue: 140 },
      players: [
        { account: max, device: 'device-Max', alliance: 'red', robot: 'uran-v2' },
        { account: sasha, device: 'device-Sasha', alliance: 'blue', robot: 'bumble-v' },
      ],
      ai: [],
    });
  });

  it('counts practice in a room when it is stopped after a while, also when the admin leaves', () => {
    const { games, join, tick } = setup();
    const admin = join('Max', null);
    admin.send({ t: 'create', format: '2v2', robot: 'uran-v2', rules: DEFAULT_RULES });
    admin.send({ t: 'mode', mode: 'practice' });
    admin.send({ t: 'ai', slot: 'blue1', robot: 'bumble-v' });
    admin.send({ t: 'start' });
    tick(MIN_PRACTICE - 1);
    admin.send({ t: 'stop' });
    expect(games).toHaveLength(0);
    admin.send({ t: 'start' });
    tick(MIN_PRACTICE + 40);
    admin.send({ t: 'leave' });
    expect(games).toEqual([expect.objectContaining({ type: 'practice', mode: 'practice', duration: MIN_PRACTICE + 40, ai: ['blue'], players: [expect.objectContaining({ account: null, name: 'Max' })] })]);
  });
});
