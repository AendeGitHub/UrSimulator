// The player's own robots kept with their account (server/AccountRobots.ts), so they are theirs on
// every computer. After signing in this browser's robots and the account's come together: each
// robot's newest version wins, and one deleted on any computer goes from the rest. Every change
// made here while signed in goes up at once. Robots made while signed out join the account that
// signs in next; another account's robots on a shared computer are left as they are.

import { CLOUD_ROBOTS, type CloudRobot } from './accountProtocol';
import { ApiError, type AccountClient } from './account';
import { withoutMesh } from '../robot/custom';
import { deleteRobot, deletedRobots, forgetDeleted, getMeshFile, onRobotsChange, putMeshFile, saveRobot, savedRobot, savedRobots, type SavedRobot } from '../robot/customStore';

/** off: signed out · syncing · done · failed: no server · full: the account had no room for some */
export type SyncState = 'off' | 'syncing' | 'done' | 'failed' | 'full';

/** A change here goes up this long after the last one (a slider dragged makes many). */
const SETTLE = 1500;

export class RobotSync {
  state: SyncState = 'off';
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly account: AccountClient,
    /** A card picture for a robot that came from the account */
    private readonly picture: (robot: SavedRobot) => Promise<string | undefined>,
    /** The robots here, or the state, changed */
    private readonly changed: () => void,
  ) {
    onRobotsChange(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.sync(), SETTLE);
    });
  }

  /** Brings this browser and the account together now (and once more after a run under way). */
  sync(): Promise<void> {
    if (!this.account.me) {
      this.setState('off');
      return Promise.resolve();
    }
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (!this.again) return;
      this.again = false;
      void this.sync();
    });
    return this.running;
  }

  private setState(state: SyncState): void {
    if (this.state === state) return;
    this.state = state;
    this.changed();
  }

  private async run(): Promise<void> {
    const me = this.account.me;
    if (!me) return;
    this.setState('syncing');
    let touched = false;
    let full = false;
    try {
      const cloud = await this.account.cloudRobots();
      // Signed out, or someone else signed in, meanwhile.
      if (this.account.me?.id !== me.id) return;
      const mine = (r: { owner?: string }) => !r.owner || r.owner === me.id;
      const there = new Map(cloud.robots.map(r => [r.id, r]));
      const models = new Set(cloud.models);

      // Deleted on another computer: gone here too, unless changed here since.
      for (const d of cloud.deleted) {
        const here = savedRobot(d.id);
        if (here && mine(here) && here.saved <= d.at && !there.has(d.id)) {
          deleteRobot(d.id, true);
          touched = true;
        }
      }
      // Deleted here (also while signed out): gone from the account, unless changed there since.
      const told: string[] = [];
      for (const d of deletedRobots()) {
        if (!mine(d)) continue;
        const kept = there.get(d.id);
        if (kept && kept.saved <= d.at) {
          await this.account.deleteCloudRobot(d.id, d.at);
          there.delete(d.id);
        }
        told.push(d.id);
      }
      if (told.length) forgetDeleted(told);

      // The account's robots that are newer than here, or not here at all, come down.
      for (const kept of there.values()) {
        const here = savedRobot(kept.id);
        if (here && (!mine(here) || here.saved >= kept.saved)) continue;
        await this.download(kept, me.id);
        touched = true;
      }
      // This browser's robots that are newer than the account's, or not there at all, go up.
      for (const here of savedRobots()) {
        if (!mine(here)) continue;
        const kept = there.get(here.id);
        if (kept && kept.saved >= here.saved) {
          if (here.owner !== me.id) saveRobot({ ...here, owner: me.id }, true);
          continue;
        }
        try {
          if (await this.upload(here, models, me.id)) touched = true;
        } catch (err) {
          if (!(err instanceof ApiError && (err.code === 'limit' || err.code === 'full'))) throw err;
          full = true;
        }
      }
      this.setState(full ? 'full' : 'done');
    } catch {
      this.setState('failed');
    } finally {
      if (touched) this.changed();
    }
  }

  /** A robot from the account, with its model file and a card picture made here. */
  private async download(kept: CloudRobot, owner: string): Promise<void> {
    const mesh = kept.blueprint.mesh;
    if (mesh && !(await getMeshFile(mesh.id).catch(() => null))) await putMeshFile(mesh.id, await this.account.cloudModel(mesh.id));
    const robot: SavedRobot = { id: kept.id, blueprint: kept.blueprint, saved: kept.saved, gallery: kept.gallery, from: kept.from, owner };
    saveRobot(robot, true);
    const thumb = await this.picture(robot).catch(() => undefined);
    if (thumb && savedRobot(robot.id)?.saved === robot.saved) saveRobot({ ...robot, thumb }, true);
  }

  /**
   * Sends a robot to the account, with its model file when the account lacks it (a model too big to
   * keep there goes without: the player's other computers show the robot as blocks). True when the
   * account had a newer version, which came down instead.
   */
  private async upload(here: SavedRobot, models: Set<string>, owner: string): Promise<boolean> {
    const mesh = here.blueprint.mesh;
    let file = mesh && !models.has(mesh.id) ? await getMeshFile(mesh.id).catch(() => null) : null;
    if (file && file.byteLength > CLOUD_ROBOTS.modelBytes) file = null;
    const blueprint = mesh && !file && !models.has(mesh.id) ? withoutMesh(here.blueprint) : here.blueprint;
    const robot: CloudRobot = { id: here.id, blueprint, saved: here.saved, gallery: here.gallery, from: here.from };
    let kept: CloudRobot;
    try {
      kept = await this.account.putCloudRobot(robot, file);
    } catch (err) {
      // The account lost the model it said it had: once more, with it.
      if (!(err instanceof ApiError && err.code === 'needModel' && mesh)) throw err;
      models.delete(mesh.id);
      return this.upload(here, models, owner);
    }
    if (file) models.add(mesh!.id);
    if (kept.saved > here.saved) {
      await this.download(kept, owner);
      return true;
    }
    if (here.owner !== owner) saveRobot({ ...here, owner }, true);
    return false;
  }
}
