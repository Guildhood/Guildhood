import * as THREE from 'three';
import { CAR_PALETTE, VEHICLE_SPECS } from '@guildhood/shared';

/** An original, procedurally built little car. Faces +z; the group's rotation.y is the heading. */
export class CarMesh {
  readonly group = new THREE.Group();
  private readonly frontWheels: THREE.Object3D[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly bodyMat: THREE.MeshLambertMaterial;
  private tag: THREE.Sprite | null = null;
  private connected = true;

  constructor(modelId: string, colorIndex: number, name: string | null) {
    const spec = VEHICLE_SPECS[modelId] ?? VEHICLE_SPECS.sprout_hatch!;
    const L = spec.length;
    const W = spec.width;
    this.bodyMat = this.mat(new THREE.MeshLambertMaterial({ color: CAR_PALETTE[colorIndex]?.hex ?? CAR_PALETTE[0]!.hex }));
    const glass = this.mat(new THREE.MeshLambertMaterial({ color: 0x24323b }));
    const trim = this.mat(new THREE.MeshLambertMaterial({ color: 0x2b2b2b }));
    const light = this.mat(new THREE.MeshBasicMaterial({ color: 0xfff3c4 }));
    const tail = this.mat(new THREE.MeshBasicMaterial({ color: 0xd23b3b }));

    const body = new THREE.Mesh(new THREE.BoxGeometry(W, 0.62, L), this.bodyMat);
    body.position.y = 0.62;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.56, L * 0.52), this.bodyMat);
    cabin.position.set(0, 1.18, -L * 0.06);
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, 0.44, 0.06), glass);
    windshield.position.set(0, 1.2, L * 0.2 + 0.01);
    const rearGlass = windshield.clone();
    rearGlass.position.z = -L * 0.32 - 0.01;
    const sideGlass = new THREE.Mesh(new THREE.BoxGeometry(W * 0.88, 0.36, L * 0.42), glass);
    sideGlass.position.set(0, 1.22, -L * 0.06);
    const bumperF = new THREE.Mesh(new THREE.BoxGeometry(W * 1.02, 0.22, 0.16), trim);
    bumperF.position.set(0, 0.42, L / 2);
    const bumperR = bumperF.clone();
    bumperR.position.z = -L / 2;
    this.group.add(body, cabin, sideGlass, windshield, rearGlass, bumperF, bumperR);

    for (const sx of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.05), light);
      hl.position.set(sx * W * 0.32, 0.72, L / 2 + 0.01);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.05), tail);
      tl.position.set(sx * W * 0.32, 0.72, -L / 2 - 0.01);
      this.group.add(hl, tl);
    }

    const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const [sx, sz] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ] as const) {
      const pivot = new THREE.Object3D();
      pivot.position.set(sx * (W / 2 - 0.06), 0.36, sz * L * 0.32);
      pivot.add(new THREE.Mesh(wheelGeo, trim));
      this.group.add(pivot);
      if (sz === 1) this.frontWheels.push(pivot);
    }

    // Soft contact shadow (cheaper than real shadows on iPad).
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 1.25, L * 1.1),
      this.mat(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.03;
    this.group.add(shadow);

    if (name) this.setName(name);
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  setColor(colorIndex: number): void {
    this.bodyMat.color.setHex(CAR_PALETTE[colorIndex]?.hex ?? CAR_PALETTE[0]!.hex);
  }

  setName(name: string): void {
    if (this.tag) {
      this.group.remove(this.tag);
      (this.tag.material as THREE.SpriteMaterial).map?.dispose();
      this.tag.material.dispose();
    }
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.font = '600 56px -apple-system, system-ui, sans-serif';
    const w = Math.min(500, ctx.measureText(name).width + 60);
    ctx.fillStyle = 'rgba(20,30,25,0.78)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect((512 - w) / 2, 14, w, 100, 50);
    else ctx.rect((512 - w) / 2, 14, w, 100); // Safari 15
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 256, 66, 460);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.scale.set(4, 1, 1);
    sprite.position.y = 2.6;
    sprite.renderOrder = 10;
    this.tag = sprite;
    this.group.add(sprite);
  }

  setPose(x: number, z: number, heading: number, steer: number): void {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = heading;
    for (const w of this.frontWheels) w.rotation.y = -steer * 0.5;
  }

  /** Disconnected players' cars are drawn faded while their seat is held. */
  setConnected(connected: boolean): void {
    if (connected === this.connected) return;
    this.connected = connected;
    for (const m of this.materials) {
      if (m === this.materials[this.materials.length - 1]) continue; // shadow keeps its opacity
      m.transparent = !connected;
      m.opacity = connected ? 1 : 0.4;
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    if (this.tag) {
      (this.tag.material as THREE.SpriteMaterial).map?.dispose();
      this.tag.material.dispose();
    }
  }
}
