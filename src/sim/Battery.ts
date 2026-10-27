// The robot's 12 V battery, about 14 V fresh off the charger. Voltage sags while motors draw
// current and slowly falls as charge is used; a flywheel left running is by far the biggest
// drain. Drive motors turn slower at lower voltage, so a tired battery makes a slow robot.

export const BATTERY = {
  /** Fully charged, at rest, V */
  full: 14,
  /** Never shown below this (the robot would brown out), V */
  empty: 10.5,
  /** Charge used per second with the flywheel at full speed, V/s */
  flywheelDrain: 0.014,
  /** Charge used per second at full drive power, V/s */
  driveDrain: 0.002,
  /** Instant drop while the flywheel spins at full speed, V */
  flywheelSag: 0.45,
  /** Instant drop at full drive power, V */
  driveSag: 0.6,
};

export class Battery {
  /** Off (Settings → Правила): always full, the robot always runs at full speed. */
  enabled = true;
  /** Resting voltage: what is left of the charge */
  private rest = BATTERY.full;
  /** Voltage under the current load, as the Driver Station shows it */
  voltage = BATTERY.full;
  /** Lowest voltage seen since the start (the number in brackets on the Driver Station) */
  minVoltage = BATTERY.full;

  reset(): void {
    this.rest = this.voltage = this.minVoltage = BATTERY.full;
  }

  /** `flywheel` and `drive` are loads from 0 (off) to 1 (full). */
  step(dt: number, flywheel: number, drive: number): void {
    if (!this.enabled) return this.reset();
    this.rest = Math.max(BATTERY.empty, this.rest - (flywheel * BATTERY.flywheelDrain + drive * BATTERY.driveDrain) * dt);
    const target = Math.max(BATTERY.empty, this.rest - flywheel * BATTERY.flywheelSag - drive * BATTERY.driveSag);
    // The reading settles over a fraction of a second rather than jumping.
    this.voltage += (target - this.voltage) * Math.min(1, dt * 4);
    this.minVoltage = Math.min(this.minVoltage, this.voltage);
  }

  /** Motor speed relative to a full battery (speed is proportional to voltage). */
  get speedScale(): number {
    return this.voltage / BATTERY.full;
  }
}
