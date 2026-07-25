import { clamp01, formatLapTime, ordinal } from '../../core/math';
import type { Simulation } from '../../game/sim/simulation';
import type { SimEvent } from '../../game/sim/state';
import { displayLap } from '../../game/sim/race';
import { getRacer } from '../../game/racers';
import { announce, clear, el } from './dom';

/**
 * The in-race HUD.
 *
 * The single constraint that shapes all of it: it has to be readable in
 * peripheral vision at 45 m/s. That means large type, high contrast against
 * *any* of the three courses' skies (hence the scrim behind every group), and
 * information placed where the eye already is — position and lap at the top
 * corners, speed and Surge at the bottom, and nothing in the middle where the
 * road is.
 */

const NOTIFICATION_TIME = 2.6;

interface Notification {
  node: HTMLElement;
  remaining: number;
}

export class Hud {
  readonly root: HTMLElement;
  private readonly position: HTMLElement;
  private readonly positionTotal: HTMLElement;
  private readonly lap: HTMLElement;
  private readonly lapTotal: HTMLElement;
  private readonly time: HTMLElement;
  private readonly lastLap: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly surgeFill: HTMLElement;
  private readonly surgeTier: HTMLElement;
  private readonly strikeState: HTMLElement;
  private readonly notifications: HTMLElement;
  private readonly countdown: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly liveRegion: HTMLElement;
  private readonly minimap: HTMLCanvasElement;
  private readonly minimapCtx: CanvasRenderingContext2D | null;
  private readonly speedLines: HTMLElement;
  private readonly standings: HTMLElement;

  private active: Notification[] = [];
  private minimapPath: Path2D | null = null;
  private minimapTransform: { scale: number; offsetX: number; offsetZ: number } | null = null;
  private reducedMotion = false;
  /** Label for the recover control, kept in sync with the player's bindings. */
  private recoverKey = 'R';

  constructor() {
    this.position = el('span', { class: 'hud__big', text: '1' });
    this.positionTotal = el('span', { class: 'hud__sub', text: '/6' });
    this.lap = el('span', { class: 'hud__big', text: '1' });
    this.lapTotal = el('span', { class: 'hud__sub', text: '/3' });
    this.time = el('span', { class: 'hud__time', text: '0:00.000' });
    this.lastLap = el('span', { class: 'hud__lastlap', text: 'Last —' });
    this.speed = el('span', { class: 'hud__speed', text: '0' });
    this.surgeFill = el('div', { class: 'surge__fill' });
    this.surgeTier = el('div', { class: 'surge__tier' });
    this.strikeState = el('div', { class: 'strike' });
    this.notifications = el('div', { class: 'hud__notifications' });
    this.countdown = el('div', { class: 'countdown', 'aria-hidden': 'true' });
    this.warning = el('div', { class: 'hud__warning', hidden: true });
    this.liveRegion = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    this.standings = el('ol', { class: 'standings' });
    this.speedLines = el('div', { class: 'speedlines', 'aria-hidden': 'true' });

    this.minimap = el('canvas', { class: 'minimap', width: 180, height: 180, 'aria-hidden': 'true' });
    this.minimapCtx = this.minimap.getContext('2d');

    this.root = el(
      'div',
      { class: 'hud', 'data-testid': 'hud' },
      this.speedLines,
      el(
        'div',
        { class: 'hud__top' },
        el(
          'div',
          { class: 'hud__panel hud__panel--position' },
          el('span', { class: 'hud__label', text: 'Position' }),
          el('div', { class: 'hud__row' }, this.position, this.positionTotal),
        ),
        el(
          'div',
          { class: 'hud__panel hud__panel--time' },
          el('span', { class: 'hud__label', text: 'Race time' }),
          this.time,
          this.lastLap,
        ),
        el(
          'div',
          { class: 'hud__panel hud__panel--lap' },
          el('span', { class: 'hud__label', text: 'Lap' }),
          el('div', { class: 'hud__row' }, this.lap, this.lapTotal),
        ),
      ),
      el('div', { class: 'hud__side' }, this.standings, this.minimap),
      this.countdown,
      this.warning,
      this.notifications,
      el(
        'div',
        { class: 'hud__bottom' },
        this.strikeState,
        el(
          'div',
          { class: 'hud__panel hud__panel--speed' },
          el('div', { class: 'hud__row hud__row--speed' }, this.speed, el('span', { class: 'hud__unit', text: 'km/h' })),
          el(
            'div',
            { class: 'surge', role: 'meter', 'aria-label': 'Surge', 'aria-valuemin': '0', 'aria-valuemax': '100' },
            this.surgeFill,
            this.surgeTier,
          ),
        ),
      ),
      this.liveRegion,
    );
  }

  /** Keeps the recover hint honest when the player has rebound the key. */
  setRecoverKey(label: string): void {
    this.recoverKey = label;
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    this.root.classList.toggle('hud--reduced', value);
  }

  /** Prepares the minimap path for a track. Called when a race is built. */
  prepare(simulation: Simulation): void {
    const track = simulation.track;
    const { minX, maxX, minZ, maxZ } = track.bounds;
    const size = this.minimap.width;
    const padding = 12;
    const scale = Math.min((size - padding * 2) / (maxX - minX), (size - padding * 2) / (maxZ - minZ));
    const offsetX = (size - (maxX - minX) * scale) / 2 - minX * scale;
    const offsetZ = (size - (maxZ - minZ) * scale) / 2 - minZ * scale;
    this.minimapTransform = { scale, offsetX, offsetZ };

    const path = new Path2D();
    track.main.samples.forEach((sample, i) => {
      const x = sample.pos.x * scale + offsetX;
      const z = sample.pos.z * scale + offsetZ;
      if (i === 0) path.moveTo(x, z);
      else path.lineTo(x, z);
    });
    path.closePath();
    this.minimapPath = path;

    this.positionTotal.textContent = `/${simulation.racers.length}`;
    this.lapTotal.textContent = `/${track.laps}`;
    clear(this.standings);
    for (let i = 0; i < simulation.racers.length; i++) {
      this.standings.append(el('li', { class: 'standings__row' }, el('span', { class: 'standings__name' })));
    }
  }

  /** One frame of HUD update. */
  update(simulation: Simulation, elapsed: number): void {
    const player = simulation.player ?? simulation.racers[0];
    if (!player) return;

    this.position.textContent = String(player.position);
    this.lap.textContent = String(displayLap(player, simulation.track));
    this.time.textContent = formatLapTime(simulation.raceTime);

    const last = player.lapTimes[player.lapTimes.length - 1];
    this.lastLap.textContent = last === undefined ? 'Last —' : `Last ${formatLapTime(last)}`;

    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    // km/h is what a player expects on a speedometer; the sim works in m/s.
    this.speed.textContent = String(Math.round(speed * 3.6));

    const surge = clamp01(player.surge);
    this.surgeFill.style.transform = `scaleX(${surge})`;
    this.surgeFill.parentElement?.setAttribute('aria-valuenow', String(Math.round(surge * 100)));
    this.surgeFill.parentElement?.classList.toggle('surge--ready', surge >= 0.2);
    this.surgeFill.parentElement?.classList.toggle('surge--active', player.boosting);
    // Drift charge rides on top of the Surge bar as a separate tick, so both
    // resources are legible without a second widget.
    this.surgeTier.style.transform = `scaleX(${clamp01(player.drift.charge)})`;
    this.surgeTier.classList.toggle('surge__tier--charging', player.drift.active);

    this.strikeState.className = `strike strike--${player.strike.phase}`;
    this.strikeState.textContent =
      player.strike.cooldown > 0 && player.strike.phase === 'idle' ? 'Pod arm resetting' : 'Pod arm ready';

    const countdown = simulation.countdown;
    if (simulation.phase === 'countdown') {
      const value = Math.ceil(countdown);
      this.countdown.textContent = value > 0 ? String(value) : 'GO';
      this.countdown.classList.add('countdown--visible');
    } else {
      this.countdown.classList.remove('countdown--visible');
    }

    // One warning slot, priority ordered. Being stuck is the more urgent of the
    // two because it is the one the player cannot fix by driving normally, and
    // it is the only place the game tells them the recover key exists.
    const wrongWay = simulation.isPlayerWrongWay();
    const stuck = simulation.phase === 'running' && !player.finished && player.wedgeTimer > 1.2;
    if (stuck) {
      this.warning.hidden = false;
      this.warning.textContent = `Stuck — press ${this.recoverKey} to recover`;
      this.warning.classList.add('hud__warning--hint');
    } else if (wrongWay) {
      this.warning.hidden = false;
      this.warning.textContent = 'Wrong way';
      this.warning.classList.remove('hud__warning--hint');
    } else {
      this.warning.hidden = true;
    }

    this.updateStandings(simulation);
    this.drawMinimap(simulation);
    this.updateSpeedLines(speed, player.boosting);
    this.tickNotifications(elapsed);
  }

  private updateStandings(simulation: Simulation): void {
    const order = [...simulation.racers].sort((a, b) => a.position - b.position);
    const rows = this.standings.children;
    order.forEach((racer, i) => {
      const row = rows[i] as HTMLElement | undefined;
      if (!row) return;
      const profile = getRacer(racer.profileId);
      const name = row.querySelector('.standings__name');
      if (name) name.textContent = `${racer.position}. ${profile.crew}`;
      row.classList.toggle('standings__row--player', racer.isPlayer);
      row.style.setProperty('--crew', `#${profile.colors.body.toString(16).padStart(6, '0')}`);
    });
  }

  private drawMinimap(simulation: Simulation): void {
    const ctx = this.minimapCtx;
    const transform = this.minimapTransform;
    if (!ctx || !transform || !this.minimapPath) return;

    ctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.stroke(this.minimapPath);
    ctx.strokeStyle = 'rgba(12,16,22,0.7)';
    ctx.lineWidth = 3;
    ctx.stroke(this.minimapPath);

    for (const racer of simulation.racers) {
      const profile = getRacer(racer.profileId);
      const x = racer.pos.x * transform.scale + transform.offsetX;
      const z = racer.pos.z * transform.scale + transform.offsetZ;
      ctx.beginPath();
      ctx.arc(x, z, racer.isPlayer ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = racer.isPlayer ? '#ffffff' : `#${profile.colors.body.toString(16).padStart(6, '0')}`;
      ctx.fill();
      if (racer.isPlayer) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#0d1117';
        ctx.stroke();
      }
    }
  }

  private updateSpeedLines(speed: number, boosting: boolean): void {
    if (this.reducedMotion) {
      this.speedLines.style.opacity = '0';
      return;
    }
    // Only above two thirds of top speed, so the effect means "fast" rather
    // than being permanent visual noise.
    const intensity = clamp01((speed - 34) / 22) * (boosting ? 1 : 0.65);
    this.speedLines.style.opacity = intensity.toFixed(3);
  }

  /** Shows a transient message, e.g. "Struck by Emberworks". */
  notify(message: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
    const node = el('div', { class: `notification notification--${kind}`, text: message });
    this.notifications.append(node);
    this.active.push({ node, remaining: NOTIFICATION_TIME });
    // Keep the stack short; older messages are no longer relevant at speed.
    while (this.active.length > 4) {
      const oldest = this.active.shift();
      oldest?.node.remove();
    }
  }

  /** Translates simulation events into HUD feedback. */
  handleEvents(events: readonly SimEvent[], simulation: Simulation): void {
    const player = simulation.player;
    if (!player) return;
    for (const event of events) {
      switch (event.type) {
        case 'lap':
          if (event.racer === player.index && event.lap < simulation.track.laps) {
            this.notify(`Lap ${event.lap + 1} — ${formatLapTime(event.time)}`, 'info');
            announce(this.liveRegion, `Lap ${event.lap + 1} of ${simulation.track.laps}. Position ${ordinal(player.position)}.`);
          }
          break;
        case 'strikeHit':
          if (event.target === player.index) {
            this.notify(`Struck by ${getRacer(simulation.racers[event.attacker]?.profileId ?? '').crew}`, 'bad');
          } else if (event.attacker === player.index) {
            this.notify(`Hit ${getRacer(simulation.racers[event.target]?.profileId ?? '').crew}`, 'good');
          }
          break;
        case 'strikeCounter':
          if (event.a === player.index || event.b === player.index) this.notify('Countered', 'info');
          break;
        case 'driftRelease':
          if (event.racer === player.index) {
            this.notify(['Drift', 'Strong drift', 'Perfect drift'][event.tier - 1] ?? 'Drift', 'good');
          }
          break;
        case 'respawn':
          if (event.racer === player.index) this.notify('Recovered to the racing line', 'info');
          break;
        case 'raceStart':
          announce(this.liveRegion, 'Go.');
          break;
        case 'finish':
          if (event.racer === player.index) {
            announce(this.liveRegion, `Finished ${ordinal(event.position)} in ${formatLapTime(event.time)}.`);
          }
          break;
        default:
          break;
      }
    }
  }

  private tickNotifications(elapsed: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const item = this.active[i];
      if (!item) continue;
      item.remaining -= elapsed;
      if (item.remaining <= 0) {
        item.node.remove();
        this.active.splice(i, 1);
      } else if (item.remaining < 0.5) {
        item.node.style.opacity = String(item.remaining / 0.5);
      }
    }
  }

  reset(): void {
    for (const item of this.active) item.node.remove();
    this.active = [];
    this.warning.hidden = true;
    this.countdown.classList.remove('countdown--visible');
  }
}
