// companion-game.ts — Phaser 3 pixel-office scene (Phase 8, §3.4).
//
// LAZY-LOADED via dynamic import from CompanionScreen so phaser (~1MB gz)
// lands in its own async chunk and is only fetched when the companion view
// actually opens. All art is PROCEDURAL placeholder pixels (Graphics →
// generateTexture): the asset-manifest seam below is where a CC0 pack
// (Kenney etc.) drops in later — load textures in preload() from the same
// keys and the rest of the scene is unchanged. Star-Office-UI assets are
// forbidden (non-commercial license) — do NOT wire them.
//
// Perf (§3.4): fps.target 15 cap; CompanionScreen sleeps game.loop when the
// state is static (no state change → no rendering, compositing only).

import Phaser from 'phaser';
import type {
  CompanionAlertLevel,
  CompanionParticipantState,
  CompanionState,
  CompanionStatus,
} from '../../types';

// ── Asset manifest (CC0 swap seam) ─────────────────────────────────────────
// To switch to a CC0 texture pack later: implement preload() to load images
// under these same keys and delete makeProceduralTextures().
const TEX = {
  floor: 'px-floor',
  desk: 'px-desk',
  charPrefix: 'px-char-', // + backend key
  mascot: 'px-mascot',
} as const;

const BACKEND_COLORS: Record<string, number> = {
  'claude-code': 0xd4a27f,
  codex: 0x9fd4a2,
  opencode: 0x7fb8d4,
  kimi: 0xc9a7eb,
  qoder: 0xe8c96a,
  default: 0x9aa0a6,
};

function backendColor(backendId: string): number {
  return BACKEND_COLORS[backendId] ?? BACKEND_COLORS.default;
}

const DESK_POS: Array<{ x: number; y: number }> = [
  { x: 70, y: 130 }, { x: 190, y: 130 }, { x: 310, y: 130 },
  { x: 70, y: 230 }, { x: 190, y: 230 }, { x: 310, y: 230 },
];
const STANDING_POS = { x: 420, y: 200 };
const MASCOT_POS = { x: 46, y: 42 };

interface CharNodes {
  sprite: Phaser.GameObjects.Sprite;
  bubbleBg: Phaser.GameObjects.Rectangle;
  bubbleText: Phaser.GameObjects.Text;
  tweens: Phaser.Tweens.Tween[];
  status: CompanionStatus | null;
}

class OfficeScene extends Phaser.Scene {
  private chars = new Map<string, CharNodes>();
  private mascotSprite!: Phaser.GameObjects.Sprite;
  private mascotText!: Phaser.GameObjects.Text;
  private mascotBg!: Phaser.GameObjects.Rectangle;
  private coordinatorHostId = '';

  constructor() {
    super('office');
  }

  create(): void {
    makeProceduralTextures(this);

    // Floor tiles.
    for (let x = 0; x < 480; x += 32) {
      for (let y = 80; y < 320; y += 32) {
        this.add.image(x, y, TEX.floor).setOrigin(0, 0);
      }
    }
    // Mascot zone.
    this.mascotBg = this.add.rectangle(8, 8, 300, 56, 0x222226, 0.85)
      .setOrigin(0, 0).setStrokeStyle(1, 0x444448);
    this.mascotSprite = this.add.sprite(MASCOT_POS.x, MASCOT_POS.y, TEX.mascot).setScale(2);
    this.mascotText = this.add.text(84, 18, '大家都在空闲', {
      fontSize: '13px', color: '#e8e8ea', fontFamily: 'monospace', wordWrap: { width: 216 },
    });
    // Desks.
    for (const pos of DESK_POS) {
      this.add.image(pos.x, pos.y, TEX.desk);
    }
  }

  applyState(state: CompanionState): void {
    // Mascot aggregate + alert styling + coordinator transition flash.
    this.mascotText.setText(state.mascot.text);
    const bgColor = state.mascot.alertLevel === 'strong' ? 0x5a1f1f
      : state.mascot.alertLevel === 'light' ? 0x1f3a24 : 0x222226;
    this.mascotBg.setFillStyle(bgColor, 0.9);
    if (this.coordinatorHostId && this.coordinatorHostId !== state.mascot.coordinatorHostId) {
      this.tweens.add({
        targets: this.mascotSprite,
        scale: { from: 1.2, to: 2 },
        duration: 350,
        ease: 'Back.easeOut',
      });
    }
    this.coordinatorHostId = state.mascot.coordinatorHostId;

    // Reconcile characters.
    const seen = new Set<string>();
    for (const p of state.participants) {
      seen.add(p.hostId);
      const nodes = this.ensureChar(p);
      this.syncChar(nodes, p);
    }
    for (const [hostId, nodes] of this.chars) {
      if (!seen.has(hostId)) {
        nodes.tweens.forEach((t) => t.stop());
        nodes.sprite.destroy();
        nodes.bubbleBg.destroy();
        nodes.bubbleText.destroy();
        this.chars.delete(hostId);
      }
    }
  }

  private ensureChar(p: CompanionParticipantState): CharNodes {
    const existing = this.chars.get(p.hostId);
    if (existing) return existing;
    const { x, y } = p.seat === 'standing' ? STANDING_POS : DESK_POS[typeof p.seat === 'number' ? p.seat : 0];
    const sprite = this.add.sprite(x, y - 14, `${TEX.charPrefix}${textureKeyFor(p.backendId)}`).setScale(2);
    const bubbleBg = this.add.rectangle(x - 52, y - 64, 104, 26, 0xf5f5f0, 0.95)
      .setOrigin(0, 0).setStrokeStyle(1, 0x333333).setVisible(false);
    const bubbleText = this.add.text(x - 48, y - 60, '', {
      fontSize: '10px', color: '#1c1c1e', fontFamily: 'monospace', wordWrap: { width: 96 },
    }).setVisible(false);
    const nodes: CharNodes = { sprite, bubbleBg, bubbleText, tweens: [], status: null };
    // Sit-down animation on join.
    sprite.setScale(0);
    this.tweens.add({ targets: sprite, scale: 2, duration: 300, ease: 'Back.easeOut' });
    this.chars.set(p.hostId, nodes);
    return nodes;
  }

  private syncChar(nodes: CharNodes, p: CompanionParticipantState): void {
    // Dusty vacant desk.
    if (p.vacated) {
      nodes.sprite.setTint(0x777777).setAlpha(0.35);
      nodes.bubbleBg.setVisible(false);
      nodes.bubbleText.setVisible(false);
      return;
    }
    nodes.sprite.clearTint().setAlpha(1);

    // Status animation (only restart tweens on a status change).
    if (nodes.status !== p.status) {
      nodes.tweens.forEach((t) => t.stop());
      nodes.tweens = [];
      nodes.sprite.setAngle(0).setAlpha(1);
      switch (p.status) {
        case 'idle':
          nodes.tweens.push(this.tweens.add({
            targets: nodes.sprite, scaleY: 1.9, duration: 1200, yoyo: true, repeat: -1,
          }));
          break;
        case 'working':
          nodes.tweens.push(this.tweens.add({
            targets: nodes.sprite, angle: { from: -4, to: 4 }, duration: 120, yoyo: true, repeat: -1,
          }));
          break;
        case 'stalled':
          nodes.tweens.push(this.tweens.add({
            targets: nodes.sprite, alpha: { from: 1, to: 0.25 }, duration: 300, yoyo: true, repeat: -1,
          }));
          break;
        case 'celebrating':
          nodes.tweens.push(this.tweens.add({
            targets: nodes.sprite, y: nodes.sprite.y - 16, duration: 220, yoyo: true, repeat: 3,
          }));
          this.confettiBurst(nodes.sprite.x, nodes.sprite.y - 20);
          break;
        case 'alert':
          nodes.sprite.setTint(0xff6b5e);
          nodes.tweens.push(this.tweens.add({
            targets: nodes.sprite, alpha: { from: 1, to: 0.5 }, duration: 200, yoyo: true, repeat: -1,
          }));
          break;
      }
      nodes.status = p.status;
    }

    // Bubble (spec shape already enforced main-side: ≤40 chars, ≤8s, ×N).
    if (p.bubble) {
      const suffix = p.bubble.count > 1 ? `  ×${p.bubble.count}` : '';
      nodes.bubbleText.setText(p.bubble.text + suffix).setVisible(true);
      nodes.bubbleBg.setVisible(true);
    } else {
      nodes.bubbleText.setVisible(false);
      nodes.bubbleBg.setVisible(false);
    }
  }

  private confettiBurst(x: number, y: number): void {
    for (let i = 0; i < 10; i += 1) {
      const c = this.add.rectangle(x, y, 4, 4, [0xffcc00, 0x34c759, 0x0a84ff, 0xff9f0a][i % 4]);
      this.tweens.add({
        targets: c,
        x: x + Phaser.Math.Between(-40, 40),
        y: y + Phaser.Math.Between(-30, 10),
        alpha: 0,
        duration: 600,
        onComplete: () => c.destroy(),
      });
    }
  }
}

function textureKeyFor(backendId: string): string {
  return backendId in BACKEND_COLORS ? backendId : 'default';
}

/** Placeholder pixel art, generated once at scene create. Replace with a
 *  CC0 pack via the TEX keys above when art lands. */
function makeProceduralTextures(scene: OfficeScene): void {
  const g = scene.add.graphics();
  // Floor tile (checker pixel).
  g.fillStyle(0x2a2a2e).fillRect(0, 0, 32, 32);
  g.fillStyle(0x2e2e33).fillRect(0, 0, 16, 16).fillRect(16, 16, 16, 16);
  g.generateTexture(TEX.floor, 32, 32).clear();
  // Desk.
  g.fillStyle(0x6b4f35).fillRect(0, 0, 56, 22);
  g.fillStyle(0x7d5f42).fillRect(0, 0, 56, 6);
  g.generateTexture(TEX.desk, 56, 22).clear();
  // Characters: 12×16 little person per backend color.
  for (const [key, color] of Object.entries(BACKEND_COLORS)) {
    g.fillStyle(color).fillRect(3, 0, 6, 5);       // head
    g.fillRect(1, 5, 10, 8);                        // body
    g.fillStyle(0x1c1c1e).fillRect(4, 2, 1, 1).fillRect(7, 2, 1, 1); // eyes
    g.generateTexture(`${TEX.charPrefix}${key}`, 12, 16).clear();
  }
  // Mascot: round blob with a star.
  g.fillStyle(0xffcc00).fillCircle(8, 8, 7);
  g.fillStyle(0x1c1c1e).fillRect(5, 6, 2, 2).fillRect(10, 6, 2, 2).fillRect(6, 11, 5, 1);
  g.generateTexture(TEX.mascot, 16, 16).clear();
  g.destroy();
}

export interface CompanionGameHandle {
  applyState: (state: CompanionState) => void;
  sleep: () => void;
  wake: () => void;
  destroy: () => void;
}

export function createCompanionGame(parent: HTMLElement): CompanionGameHandle {
  const scene = new OfficeScene();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: 480,
    height: 320,
    backgroundColor: '#141416',
    fps: { target: 15 }, // §3.4 perf budget: static scene runs ≤15fps
    scene: [scene],
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  });
  return {
    applyState: (state) => scene.applyState(state),
    sleep: () => game.loop.sleep(),
    wake: () => game.loop.wake(),
    destroy: () => game.destroy(true),
  };
}
