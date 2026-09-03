import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { type Card } from "../game/cards.js";
import { type GameState, type Side, lightsOf } from "../game/engine.js";
import { makeDust, ParticleBurst } from "./effects.js";
import { makeFigure } from "./figure.js";
import { LampPanel } from "./lampPanel.js";
import { cardBackTexture, cardFaceTexture, feltTexture, labelTexture } from "./textures.js";
import { tweenTo, updateTweens } from "./tween.js";

const CARD_W = 0.63;
const CARD_H = 0.88;
const CARD_T = 0.004;

type Slot = "playerHand" | "aiHand" | "playerPlay" | "aiPlay" | "deck" | "discard";

interface CardNode {
  card: Card;
  group: THREE.Group;
  slot: Slot;
  faceUp: boolean;
  targetKey: string;
}

export interface TableCallbacks {
  onCardClick(cardId: string): void;
}

const DECK_POS = new THREE.Vector3(-3.4, 0.3, -3.0);
const DISCARD_POS = new THREE.Vector3(3.4, 0.05, -3.0);
const PLAY_Z = { player: 0.62, ai: -0.62 };

export class TableScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly cards = new Map<string, CardNode>();
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private figures: Record<Side, THREE.Group[]> = { player: [], ai: [] };
  private figureMats: Record<Side, { body: THREE.MeshStandardMaterial; base: THREE.MeshStandardMaterial }>;
  private lamps: Record<Side, LampPanel>;
  private burst: ParticleBurst;
  private dust: THREE.Points;
  private spot: THREE.SpotLight;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(-10, -10);
  private hovered: string | null = null;
  private selectable = new Set<string>();
  private lastState: GameState | null = null;
  private backMat: THREE.MeshStandardMaterial;
  private edgeMat: THREE.MeshStandardMaterial;
  private slotMats: Record<Side, THREE.MeshBasicMaterial>;
  private shake = 0;
  private lastFrame = 0;
  // 参考机位（宽屏）。窄屏 / 竖屏时按宽高比从这里往后拉并放大视角，保证桌面左右两侧不被裁掉。
  private static readonly CAMERA_HOME = new THREE.Vector3(0, 5.7, 6.1);
  // 竖屏机位：更俯视一些，桌面在画面里更接近正圆，纵向填得更满。
  private static readonly CAMERA_HOME_PORTRAIT = new THREE.Vector3(0, 6.6, 5.0);
  /** 0 = 宽屏机位，1 = 竖屏机位；竖屏时手牌放大、拉近，命数小人往外挪。 */
  private portrait = 0;
  /** 两侧的出牌位（描边框 + 圆环），竖屏时整组放大并撑开。 */
  private playSlots = {} as Record<Side, THREE.Group>;
  private static readonly FOG_DENSITY = 0.045;
  private cameraBase = TableScene.CAMERA_HOME.clone();
  private cameraTarget = new THREE.Vector3(0, 0.15, -0.1);
  private flash = 0;
  private flashColor = new THREE.Color("#ffffff");
  private flashLight: THREE.PointLight;

  constructor(private container: HTMLElement, private callbacks: TableCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.copy(this.cameraBase);
    this.camera.lookAt(this.cameraTarget);

    this.scene.background = new THREE.Color("#050408");
    this.scene.fog = new THREE.FogExp2("#050408", 0.045);

    this.backMat = new THREE.MeshStandardMaterial({ map: cardBackTexture(), roughness: 0.55, alphaTest: 0.5 });
    this.edgeMat = new THREE.MeshStandardMaterial({ color: "#e9e4d8", roughness: 0.8 });
    this.figureMats = {
      player: {
        body: new THREE.MeshStandardMaterial({ color: "#3b7bff", roughness: 0.35, metalness: 0.25, emissive: "#0a1f66", emissiveIntensity: 0.35 }),
        base: new THREE.MeshStandardMaterial({ color: "#1b2a55", roughness: 0.4, metalness: 0.6 })
      },
      ai: {
        body: new THREE.MeshStandardMaterial({ color: "#e0273f", roughness: 0.35, metalness: 0.25, emissive: "#5a0a14", emissiveIntensity: 0.35 }),
        base: new THREE.MeshStandardMaterial({ color: "#4a1218", roughness: 0.4, metalness: 0.6 })
      }
    };
    this.slotMats = {
      player: new THREE.MeshBasicMaterial({ color: "#d4a24c", transparent: true, opacity: 0.16 }),
      ai: new THREE.MeshBasicMaterial({ color: "#d4a24c", transparent: true, opacity: 0.16 })
    };

    this.spot = this.buildEnvironment();
    this.lamps = { player: new LampPanel("KAIJI"), ai: new LampPanel("KAZUYA") };
    this.lamps.player.group.position.set(-2.75, 0, 1.75);
    this.lamps.player.group.rotation.y = 0.35;
    this.lamps.ai.group.position.set(2.3, 0, -2.25);
    this.lamps.ai.group.rotation.y = -0.3;
    this.scene.add(this.lamps.player.group, this.lamps.ai.group);
    this.burst = new ParticleBurst(this.scene);
    this.dust = makeDust(this.scene);
    this.flashLight = new THREE.PointLight("#ffffff", 0, 14, 1.2);
    this.flashLight.position.set(0, 3, 0);
    this.scene.add(this.flashLight);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.4, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // iOS Safari 上容器高度会在首帧之后随地址栏 / dvh 变化，且不一定触发 window resize，
    // 画布若不跟着重设就会被 CSS 拉伸变形。这里用 ResizeObserver 监听容器本身，另在每帧兜底核对。
    window.addEventListener("resize", () => this.resize());
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.resize()).observe(container);
    this.renderer.domElement.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.renderer.domElement.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.resize();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  // ---------- environment ----------

  private buildEnvironment(): THREE.SpotLight {
    const felt = new THREE.Mesh(
      new THREE.CircleGeometry(4.7, 96),
      new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.95 })
    );
    felt.rotation.x = -Math.PI / 2;
    felt.receiveShadow = true;
    this.scene.add(felt);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(4.7, 0.24, 20, 128),
      new THREE.MeshStandardMaterial({ color: "#2a1a12", roughness: 0.45, metalness: 0.15 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.02;
    rim.receiveShadow = true;
    this.scene.add(rim);

    const goldRing = new THREE.Mesh(
      new THREE.TorusGeometry(4.47, 0.02, 8, 160),
      new THREE.MeshStandardMaterial({ color: "#d4a24c", emissive: "#d4a24c", emissiveIntensity: 0.9, metalness: 0.9, roughness: 0.2 })
    );
    goldRing.rotation.x = Math.PI / 2;
    goldRing.position.y = 0.01;
    this.scene.add(goldRing);

    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(4.3, 3.4, 1.4, 64),
      new THREE.MeshStandardMaterial({ color: "#0f0d14", roughness: 0.6, metalness: 0.4 })
    );
    pedestal.position.y = -0.72;
    this.scene.add(pedestal);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: "#07060a", roughness: 0.9, metalness: 0.2 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.42;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // grid of faint floor lines for depth
    const grid = new THREE.GridHelper(60, 60, "#1c1826", "#120f18");
    grid.position.y = -1.41;
    this.scene.add(grid);

    // neon pillars in the background
    for (let i = 0; i < 10; i += 1) {
      const angle = (i / 10) * Math.PI * 2;
      const r = 11;
      const pillar = new THREE.Mesh(
        new THREE.BoxGeometry(0.35, 9, 0.35),
        new THREE.MeshStandardMaterial({ color: "#0b0a10", roughness: 0.5, metalness: 0.6 })
      );
      pillar.position.set(Math.cos(angle) * r, 3, Math.sin(angle) * r);
      this.scene.add(pillar);
      const neon = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 8.6, 0.05),
        new THREE.MeshStandardMaterial({
          color: i % 2 ? "#ff3346" : "#d4a24c",
          emissive: i % 2 ? "#ff3346" : "#d4a24c",
          emissiveIntensity: 1.6
        })
      );
      neon.position.set(Math.cos(angle) * (r - 0.2), 3, Math.sin(angle) * (r - 0.2));
      this.scene.add(neon);
    }

    // play slots
    // 出牌位整组放在一个 Group 里：竖屏时连同打出的牌一起放大、往两侧撑开。
    for (const side of ["player", "ai"] as Side[]) {
      const slot = new THREE.Group();
      slot.position.set(0, 0, PLAY_Z[side]);
      const outline = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W + 0.16, CARD_H + 0.16), this.slotMats[side]);
      outline.rotation.x = -Math.PI / 2;
      outline.position.set(0, 0.003, 0);
      slot.add(outline);
      const inner = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.52, 48),
        new THREE.MeshBasicMaterial({ color: "#d4a24c", transparent: true, opacity: 0.25, side: THREE.DoubleSide })
      );
      inner.rotation.x = -Math.PI / 2;
      inner.position.set(0, 0.004, 0);
      slot.add(inner);
      this.scene.add(slot);
      this.playSlots[side] = slot;
    }

    // decorative deck / discard markers
    const deckBase = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 0.28, 1.1),
      new THREE.MeshStandardMaterial({ color: "#1a171f", roughness: 0.4, metalness: 0.6 })
    );
    deckBase.position.set(DECK_POS.x, 0.14, DECK_POS.z);
    deckBase.castShadow = true;
    this.scene.add(deckBase);
    const deckLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.2, 0.3),
      new THREE.MeshBasicMaterial({ map: labelTexture("MOTHER SOPHIE", "#d4a24c"), transparent: true })
    );
    deckLabel.rotation.x = -Math.PI / 2;
    deckLabel.position.set(DECK_POS.x, 0.005, DECK_POS.z + 0.8);
    this.scene.add(deckLabel);
    const discardLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.0, 0.3),
      new THREE.MeshBasicMaterial({ map: labelTexture("弃牌", "#9a917f"), transparent: true })
    );
    discardLabel.rotation.x = -Math.PI / 2;
    discardLabel.position.set(DISCARD_POS.x, 0.005, DISCARD_POS.z + 0.8);
    this.scene.add(discardLabel);

    // lights
    this.scene.add(new THREE.AmbientLight("#ffffff", 0.22));
    const spot = new THREE.SpotLight("#fff1d6", 85, 24, Math.PI / 4.6, 0.55, 1.5);
    spot.position.set(0, 7.5, 1.2);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.bias = -0.0004;
    spot.target.position.set(0, 0, 0);
    this.scene.add(spot, spot.target);
    const fillBlue = new THREE.PointLight("#6f8dff", 18, 14, 1.5);
    fillBlue.position.set(-5, 3, 4);
    this.scene.add(fillBlue);
    const fillRed = new THREE.PointLight("#ff6a5a", 16, 14, 1.5);
    fillRed.position.set(5, 3, -4);
    this.scene.add(fillRed);

    const title = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 0.85),
      new THREE.MeshBasicMaterial({ map: labelTexture("ONE POKER", "#d4a24c"), transparent: true })
    );
    title.position.set(0, 2.4, -6.5);
    this.scene.add(title);
    return spot;
  }

  // ---------- frame loop ----------

  private sizedW = 0;
  private sizedH = 0;

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h || (w === this.sizedW && h === this.sizedH)) return;
    this.sizedW = w;
    this.sizedH = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.frameCamera();
    this.camera.updateProjectionMatrix();
    // 竖屏时开司的指示灯往桌心收一点，避免被左边框裁掉。
    this.lamps.player.group.position.x = -2.75 + 0.5 * this.portrait;
    this.layoutPlaySlots();
    if (this.lastState) {
      this.layoutHands();
      this.layoutFigures(this.lastState);
    }
  }

  /**
   * 竖屏 / 窄屏取景：桌面是按 3:2 左右的画幅设计的，宽高比更窄时水平视野不够。
   * 需要的水平覆盖倍数 need = 1.5 / aspect，一部分靠加大视角（最多 1.6 倍 tan），
   * 其余靠把相机沿视线往后拉；雾的密度同步变稀，避免拉远后整桌发灰。
   */
  private frameCamera() {
    const aspect = this.camera.aspect || 1;
    // 超宽（手机横屏）时也略微后拉，给底部手牌和左下操作区留出余量。
    // 竖屏只保证 ±3.5 左右（两块指示灯）进画面，牌堆 / 弃牌堆边缘可以出框，换牌面更大。
    const need = Math.max(1, 1.2 / aspect, Math.min(1.25, aspect / 1.9));
    const portrait = THREE.MathUtils.clamp((1.5 / aspect - 1) / 1.5, 0, 1);
    this.portrait = portrait;
    const fovScale = Math.min(1.6, Math.sqrt(need));
    const dolly = need / fovScale;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(20)) * fovScale));
    // 竖屏时底部有操作面板，把注视点往玩家侧挪一点，整桌在屏幕里就会往上抬，给底部操作区让位。
    this.cameraTarget.z = -0.1 + portrait * 0.75;
    const home = TableScene.CAMERA_HOME.clone().lerp(TableScene.CAMERA_HOME_PORTRAIT, portrait);
    this.cameraBase.copy(home).sub(this.cameraTarget).multiplyScalar(dolly).add(this.cameraTarget);
    (this.scene.fog as THREE.FogExp2).density = TableScene.FOG_DENSITY / dolly;
  }

  private frame(now: number) {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000 || 0.016);
    this.lastFrame = now;
    if (this.container.clientWidth !== this.sizedW || this.container.clientHeight !== this.sizedH) this.resize();
    updateTweens(now);
    this.updateHover();
    this.burst.update(now);
    this.lamps.player.update(dt);
    this.lamps.ai.update(dt);
    this.dust.rotation.y += dt * 0.02;
    (this.dust.material as THREE.PointsMaterial).opacity = 0.25 + Math.sin(now / 900) * 0.08;

    // slot pulse
    const pulse = 0.14 + (Math.sin(now / 500) + 1) * 0.05;
    this.slotMats.player.opacity = pulse;
    this.slotMats.ai.opacity = pulse;

    // camera shake + flash decay
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.shake * this.shake * 0.35;
    this.camera.position.set(
      this.cameraBase.x + (Math.random() - 0.5) * s,
      this.cameraBase.y + (Math.random() - 0.5) * s,
      this.cameraBase.z + (Math.random() - 0.5) * s
    );
    this.camera.lookAt(this.cameraTarget);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    this.flashLight.intensity = this.flash * 14;
    this.flashLight.color.copy(this.flashColor);
    this.spot.intensity = 85 + this.flash * 20;

    this.composer.render();
  }

  // ---------- input ----------

  private onPointerMove(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private onPointerDown(e: PointerEvent) {
    this.onPointerMove(e);
    this.updateHover();
    if (this.hovered && this.selectable.has(this.hovered)) {
      this.callbacks.onCardClick(this.hovered);
    }
  }

  private updateHover() {
    if (!this.selectable.size) {
      if (this.hovered) {
        this.hovered = null;
        this.renderer.domElement.style.cursor = "default";
      }
      return;
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes: THREE.Object3D[] = [];
    for (const id of this.selectable) {
      const node = this.cards.get(id);
      if (node) meshes.push(node.group);
    }
    const hits = this.raycaster.intersectObjects(meshes, true);
    let id: string | null = null;
    if (hits.length) {
      let obj: THREE.Object3D | null = hits[0].object;
      while (obj && !obj.userData.cardId) obj = obj.parent;
      id = obj?.userData.cardId ?? null;
    }
    if (id !== this.hovered) {
      this.hovered = id;
      this.renderer.domElement.style.cursor = id ? "pointer" : "default";
      this.layoutHands();
    }
  }

  // ---------- cards ----------

  private makeCard(card: Card): CardNode {
    const group = new THREE.Group();
    group.userData.cardId = card.id;
    const body = new THREE.Mesh(this.cardBodyGeometry(), this.edgeMat);
    body.castShadow = true;
    const front = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W, CARD_H),
      // 贴图四角透明（圆角），alphaTest 把角裁掉，露出下面同样是圆角的牌身。
      new THREE.MeshStandardMaterial({ map: cardFaceTexture(card), color: "#d9d9d9", roughness: 0.6, alphaTest: 0.5 })
    );
    front.rotation.x = -Math.PI / 2;
    front.position.y = CARD_T / 2 + 0.001;
    const back = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), this.backMat);
    // Rotate the back print 180° in-plane so a face-down card (group z = π) reads upright from the player's seat.
    back.rotation.set(Math.PI / 2, 0, Math.PI);
    back.position.y = -CARD_T / 2 - 0.001;
    group.add(body, front, back);
    group.position.copy(DECK_POS);
    group.rotation.set(0, 0, Math.PI);
    this.scene.add(group);
    const node: CardNode = { card, group, slot: "deck", faceUp: false, targetKey: "" };
    this.cards.set(card.id, node);
    return node;
  }

  private bodyGeo?: THREE.BufferGeometry;
  /** 圆角矩形挤出的牌身，厚度 CARD_T，平躺在 XZ 平面（与原 BoxGeometry 同向）。 */
  private cardBodyGeometry(): THREE.BufferGeometry {
    if (this.bodyGeo) return this.bodyGeo;
    const r = CARD_W * (22 / 256);
    const w = CARD_W / 2;
    const h = CARD_H / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-w + r, -h);
    shape.lineTo(w - r, -h);
    shape.absarc(w - r, -h + r, r, -Math.PI / 2, 0, false);
    shape.lineTo(w, h - r);
    shape.absarc(w - r, h - r, r, 0, Math.PI / 2, false);
    shape.lineTo(-w + r, h);
    shape.absarc(-w + r, h - r, r, Math.PI / 2, Math.PI, false);
    shape.lineTo(-w, -h + r);
    shape.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: CARD_T, bevelEnabled: false, curveSegments: 8 });
    geo.translate(0, 0, -CARD_T / 2);
    geo.rotateX(Math.PI / 2);
    this.bodyGeo = geo;
    return geo;
  }

  private moveTo(node: CardNode, pos: THREE.Vector3, rot: THREE.Euler, duration: number, arc: number) {
    const key = `${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}|${rot.x.toFixed(3)},${rot.y.toFixed(3)},${rot.z.toFixed(3)}`;
    if (node.targetKey === key) return;
    node.targetKey = key;
    void tweenTo(node.group, pos, rot, duration, arc);
  }

  /** Move every card / figure / lamp to where the state says it should be. */
  sync(state: GameState, selectablePlayerCards: boolean): void {
    this.lastState = state;
    const inPlay = new Set<string>();
    const place = (card: Card, slot: Slot, faceUp: boolean) => {
      inPlay.add(card.id);
      const node = this.cards.get(card.id) ?? this.makeCard(card);
      node.slot = slot;
      node.faceUp = faceUp;
      node.group.visible = true;
    };
    for (const c of state.players.player.hand) place(c, "playerHand", true);
    for (const c of state.players.ai.hand) place(c, "aiHand", false);
    // Played cards are turned over once the round is resolved, whether by showdown or fold.
    const revealed = state.phase === "showdown" || state.phase === "gameover";
    if (state.players.player.chosen) place(state.players.player.chosen, "playerPlay", revealed);
    if (state.players.ai.chosen) place(state.players.ai.chosen, "aiPlay", revealed);

    for (const [id, node] of this.cards) {
      if (!inPlay.has(id) && node.slot !== "discard") {
        node.slot = "discard";
        node.faceUp = false;
        node.targetKey = "discard";
        tweenTo(node.group, DISCARD_POS.clone(), new THREE.Euler(0, 0, Math.PI), 520, 0.5).then(() => {
          if (node.slot === "discard") {
            node.group.visible = false;
            this.cards.delete(id);
            this.scene.remove(node.group);
          }
        });
      }
    }

    this.selectable = new Set(selectablePlayerCards ? state.players.player.hand.map((c) => c.id) : []);
    this.layoutHands();
    this.layoutFigures(state);
    this.updateLamps(state);
  }

  /** 竖屏时桌心出牌位与打出的牌的放大倍率。 */
  private playScale(): number {
    return 1 + 0.85 * this.portrait;
  }

  /** 出牌位在桌面上的实际 z：放大后往两侧撑开，整对再往和也那侧挪一点给底部手牌腾地方。 */
  private playZ(side: Side): number {
    return PLAY_Z[side] * this.playScale() - 0.3 * this.portrait;
  }

  /** 出牌位跟着 playScale 一起放大 / 分开，牌与描边框始终对齐。 */
  private layoutPlaySlots() {
    const s = this.playScale();
    for (const side of ["player", "ai"] as Side[]) {
      const slot = this.playSlots[side];
      if (!slot) continue;
      slot.scale.setScalar(s);
      slot.position.z = this.playZ(side);
    }
  }

  private layoutHands() {
    const state = this.lastState;
    if (!state) return;
    // Player: cards held upright, leaning back toward the camera so they read like a real hand.
    // 竖屏：手牌放大并拉近镜头，牌面更立一点正对着较高的机位。
    const t = this.portrait;
    const ph = state.players.player.hand;
    const hs = 1 + 0.55 * t;
    ph.forEach((c, i) => {
      const node = this.cards.get(c.id);
      if (!node || node.slot !== "playerHand") return;
      const n = ph.length;
      const x = (i - (n - 1) / 2) * (CARD_W * hs + 0.22);
      const hover = this.hovered === c.id;
      const lift = hover ? 0.16 : 0;
      node.group.scale.setScalar(hs);
      // 出牌后只剩一张时，竖屏把它往桌心收一点，抬出底部下注面板的遮挡范围。
      const z = 2.75 + (n === 1 ? 0.3 : 1.0) * t;
      this.moveTo(
        node,
        new THREE.Vector3(x, 0.5 * hs + lift, z - lift * 0.25),
        new THREE.Euler(0.95 - 0.3 * t, 0, 0),
        hover ? 130 : 480,
        0
      );
    });
    // AI: face-down cards standing in his reader box on the far side.
    const ah = state.players.ai.hand;
    ah.forEach((c, i) => {
      const node = this.cards.get(c.id);
      if (!node || node.slot !== "aiHand") return;
      const n = ah.length;
      const as = 1 + 0.25 * t;
      const x = (i - (n - 1) / 2) * (CARD_W * as + 0.22);
      node.group.scale.setScalar(as);
      this.moveTo(node, new THREE.Vector3(x, 0.45 * as, -2.6), new THREE.Euler(0.95, 0, Math.PI), 480, 0);
    });
    // 桌面中央打出的牌：竖屏时同样放大，并把两个出牌位往各自方向撑开，免得放大后叠在一起。
    const ps = this.playScale();
    const play = (card: Card | null, side: Side) => {
      if (!card) return;
      const node = this.cards.get(card.id);
      if (!node) return;
      // Kazuya's played card faces him (print upside-down to the player); yours faces you.
      const yaw = side === "ai" ? Math.PI : 0;
      node.group.scale.setScalar(ps);
      this.moveTo(
        node,
        new THREE.Vector3(0, 0.02 * ps, this.playZ(side)),
        new THREE.Euler(0, yaw, node.faceUp ? 0 : Math.PI),
        560,
        0.7
      );
    };
    play(state.players.player.chosen, "player");
    play(state.players.ai.chosen, "ai");
  }

  // ---------- figures ("lives") ----------

  private figureAt(side: Side, index: number): THREE.Group {
    const list = this.figures[side];
    while (list.length <= index) {
      const f = makeFigure(this.figureMats[side].body, this.figureMats[side].base);
      f.position.set(side === "player" ? 2.6 : -2.6, 0, side === "player" ? 2.6 : -2.6);
      f.visible = false;
      this.scene.add(f);
      list.push(f);
    }
    return list[index];
  }

  private layoutFigures(state: GameState) {
    for (const side of ["player", "ai"] as Side[]) {
      const p = state.players[side];
      const dir = side === "player" ? 1 : -1;
      const reserve = Math.max(0, p.lives - p.stake);
      const total = reserve + p.stake;
      // reserve: a grid beside each player's own area, well clear of the play slots
      for (let i = 0; i < total; i += 1) {
        const f = this.figureAt(side, i);
        f.visible = true;
        let target: THREE.Vector3;
        if (i < reserve) {
          // reserve troops stand in ranks beside the owner's own hand, never in front of the play slots
          const cols = Math.min(8, Math.max(4, Math.ceil(reserve / 3)));
          const col = i % cols;
          const row = Math.floor(i / cols);
          // 竖屏手牌放大后会顶到玩家侧的小人，把小人往外挪一点。
          const out = side === "player" ? 0.6 * this.portrait : 0;
          target = new THREE.Vector3(dir * (1.25 + out + col * 0.31), 0, dir * (2.0 + row * 0.34));
        } else {
          // staked figures walk to the pot, beside the player's own slot
          const k = i - reserve;
          const col = k % 4;
          const row = Math.floor(k / 4);
          target = new THREE.Vector3(dir * (1.35 + col * 0.32), 0, PLAY_Z[side] + dir * (row * 0.36 - 0.25));
        }
        const rot = new THREE.Euler(0, side === "player" ? Math.PI : 0, 0);
        if (f.position.distanceToSquared(target) > 1e-6) void tweenTo(f, target, rot, 520, i >= reserve ? 0.35 : 0.15);
      }
      for (let i = total; i < this.figures[side].length; i += 1) {
        const f = this.figures[side][i];
        if (f.visible) {
          // lost life: walks over to the winner's side then disappears
          const away = new THREE.Vector3(-dir * 2.2, 0, -dir * 2.2);
          void tweenTo(f, away, new THREE.Euler(0, 0, 0), 700, 0.5).then(() => {
            f.visible = false;
          });
        }
      }
    }
  }

  private updateLamps(state: GameState) {
    for (const side of ["player", "ai"] as Side[]) {
      const p = state.players[side];
      const resolved = state.phase === "showdown" || state.phase === "gameover";
      const cards = p.chosen && !resolved ? [p.chosen, ...p.hand] : p.hand;
      let up = 0;
      for (const c of cards) if (c.rank >= 8) up += 1;
      this.lamps[side].setLights({ up, down: cards.length - up });
    }
    void lightsOf;
  }

  // ---------- effects ----------

  playerWins(big = false): void {
    this.burst.burst(
      new THREE.Vector3(0, 0.4, this.playZ("player")),
      [new THREE.Color("#ffd700"), new THREE.Color("#ffffff"), new THREE.Color("#7fb6ff"), new THREE.Color("#fff2b0")],
      big ? 2.2 : 1.2,
      big ? 4.5 : 3
    );
    this.flashColor.set("#ffe9a8");
    this.flash = 1;
    this.shake = big ? 0.6 : 0.3;
  }

  playerLoses(big = false): void {
    this.burst.burst(
      new THREE.Vector3(0, 0.4, this.playZ("ai")),
      [new THREE.Color("#ff2a2a"), new THREE.Color("#ff7a00"), new THREE.Color("#5a0000")],
      big ? 2 : 1,
      big ? 3.5 : 2.4
    );
    this.flashColor.set("#ff3030");
    this.flash = 1;
    this.shake = big ? 1 : 0.55;
  }

  draw(): void {
    this.flashColor.set("#b0b0ff");
    this.flash = 0.5;
  }
}
