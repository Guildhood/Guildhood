import * as THREE from 'three';
import type { CarState, WorldMap } from '@guildhood/shared';
import { CarMesh } from './car-mesh.ts';

/** Renders a neighborhood layout and the cars in it, with a smoothed chase camera. */
export class WorldView {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.5, 600);
  private readonly cars = new Map<string, CarMesh>();
  private readonly disposables: { dispose(): void }[] = [];
  private camInit = false;
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  contextLost = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly world: WorldMap,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    this.scene.background = new THREE.Color(0x9fc7e3);
    this.scene.fog = new THREE.Fog(0x9fc7e3, 120, 320);
    this.build();
    this.resize();
  }

  private track<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private build(): void {
    const w = this.world;
    const S = w.halfSize * 2;
    this.scene.add(new THREE.HemisphereLight(0xe8f4ff, 0x4a6b3a, 1.1));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);

    const grassMat = this.track(new THREE.MeshLambertMaterial({ color: 0x6fae5a }));
    const outerMat = this.track(new THREE.MeshLambertMaterial({ color: 0x5c9a4b }));
    const outer = new THREE.Mesh(this.track(new THREE.PlaneGeometry(S * 3, S * 3)), outerMat);
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.05;
    const ground = new THREE.Mesh(this.track(new THREE.PlaneGeometry(S, S)), grassMat);
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(outer, ground);

    const parkMat = this.track(new THREE.MeshLambertMaterial({ color: 0x86c06a }));
    for (const p of w.parks) {
      const m = new THREE.Mesh(this.track(new THREE.PlaneGeometry(p.w, p.d)), parkMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(p.x, 0.01, p.z);
      this.scene.add(m);
    }

    const roadMat = this.track(new THREE.MeshLambertMaterial({ color: 0x4b4f55 }));
    const lineMat = this.track(new THREE.MeshBasicMaterial({ color: 0xf3e9c9 }));
    const dashGeo = this.track(new THREE.PlaneGeometry(0.3, 3));
    for (const r of w.roads) {
      const m = new THREE.Mesh(this.track(new THREE.PlaneGeometry(r.w, r.d)), roadMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(r.x, 0.02, r.z);
      this.scene.add(m);
      // Dashed center line along the road's long axis.
      const alongX = r.w > r.d;
      const len = alongX ? r.w : r.d;
      for (let t = -len / 2 + 4; t < len / 2 - 2; t += 7) {
        const d = new THREE.Mesh(dashGeo, lineMat);
        d.rotation.x = -Math.PI / 2;
        if (alongX) d.rotation.z = Math.PI / 2;
        d.position.set(alongX ? r.x + t : r.x, 0.03, alongX ? r.z : r.z + t);
        this.scene.add(d);
      }
    }

    const roofGeo = this.track(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1));
    roofGeo.rotateY(Math.PI / 4);
    const doorMat = this.track(new THREE.MeshLambertMaterial({ color: 0x5b3a29 }));
    const windowMat = this.track(new THREE.MeshLambertMaterial({ color: 0xbfd9e6 }));
    const wallMats = new Map<number, THREE.Material>();
    const roofMats = new Map<number, THREE.Material>();
    const matFor = (cache: Map<number, THREE.Material>, hex: number) => {
      let m = cache.get(hex);
      if (!m) cache.set(hex, (m = this.track(new THREE.MeshLambertMaterial({ color: hex }))));
      return m;
    };
    const unitBox = this.track(new THREE.BoxGeometry(1, 1, 1));
    for (const b of w.buildings) {
      const walls = new THREE.Mesh(unitBox, matFor(wallMats, b.wall));
      walls.scale.set(b.w, b.h, b.d);
      walls.position.set(b.x, b.h / 2, b.z);
      const roof = new THREE.Mesh(roofGeo, matFor(roofMats, b.roof));
      const roofH = b.kind === 'house' ? 3 : 1.2;
      roof.scale.set(b.w * 1.08, roofH, b.d * 1.08);
      roof.position.set(b.x, b.h + roofH / 2, b.z);
      this.scene.add(walls, roof);
      // Door and windows on the face nearest the world center (toward the street).
      const faceX = Math.abs(b.x) > Math.abs(b.z);
      const sign = faceX ? -Math.sign(b.x) || 1 : -Math.sign(b.z) || 1;
      const door = new THREE.Mesh(unitBox, doorMat);
      door.scale.set(faceX ? 0.1 : 1.4, 2.4, faceX ? 1.4 : 0.1);
      door.position.set(faceX ? b.x + sign * (b.w / 2) : b.x, 1.2, faceX ? b.z : b.z + sign * (b.d / 2));
      this.scene.add(door);
      for (const off of [-0.3, 0.3]) {
        const win = new THREE.Mesh(unitBox, windowMat);
        const span = faceX ? b.d : b.w;
        win.scale.set(faceX ? 0.1 : 1.6, 1.4, faceX ? 1.6 : 0.1);
        win.position.set(
          faceX ? b.x + sign * (b.w / 2) : b.x + off * span,
          b.h * 0.62,
          faceX ? b.z + off * span : b.z + sign * (b.d / 2),
        );
        this.scene.add(win);
      }
    }

    const trunkGeo = this.track(new THREE.CylinderGeometry(0.25, 0.32, 1, 8));
    const leafGeo = this.track(new THREE.IcosahedronGeometry(1, 0));
    const trunkMat = this.track(new THREE.MeshLambertMaterial({ color: 0x7a5236 }));
    const leafMat = this.track(new THREE.MeshLambertMaterial({ color: 0x3f7f3a, flatShading: true }));
    for (const t of w.trees) {
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.scale.set(1, t.h * 0.45, 1);
      trunk.position.set(t.x, (t.h * 0.45) / 2, t.z);
      const leaves = new THREE.Mesh(leafGeo, leafMat);
      leaves.scale.setScalar(t.h * 0.32);
      leaves.position.set(t.x, t.h * 0.65, t.z);
      this.scene.add(trunk, leaves);
    }

    const stoneMat = this.track(new THREE.MeshLambertMaterial({ color: 0xc9c2b2 }));
    const waterMat = this.track(new THREE.MeshLambertMaterial({ color: 0x5fb3d9 }));
    for (const p of w.props) {
      const basin = new THREE.Mesh(this.track(new THREE.CylinderGeometry(p.r, p.r * 1.05, 0.9, 24)), stoneMat);
      basin.position.set(p.x, 0.45, p.z);
      const water = new THREE.Mesh(this.track(new THREE.CylinderGeometry(p.r * 0.85, p.r * 0.85, 0.1, 24)), waterMat);
      water.position.set(p.x, 0.86, p.z);
      const spout = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.3, 0.5, 2.2, 10)), stoneMat);
      spout.position.set(p.x, 1.4, p.z);
      this.scene.add(basin, water, spout);
    }

    // Fence around the edge.
    const fenceMat = this.track(new THREE.MeshLambertMaterial({ color: 0xe8e2d3 }));
    const h = w.halfSize;
    for (const [x, z, sx, sz] of [
      [0, -h, S, 0.4],
      [0, h, S, 0.4],
      [-h, 0, 0.4, S],
      [h, 0, 0.4, S],
    ] as const) {
      const f = new THREE.Mesh(unitBox, fenceMat);
      f.scale.set(sx, 1.2, sz);
      f.position.set(x, 0.6, z);
      this.scene.add(f);
    }
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const hgt = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / Math.max(1, hgt);
    this.camera.updateProjectionMatrix();
  }

  upsertCar(id: string, model: string, color: number, name: string | null): CarMesh {
    let car = this.cars.get(id);
    if (!car) {
      car = new CarMesh(model, color, name);
      this.cars.set(id, car);
      this.scene.add(car.group);
    } else {
      car.setColor(color);
      if (name) car.setName(name);
    }
    return car;
  }

  car(id: string): CarMesh | undefined {
    return this.cars.get(id);
  }

  removeCar(id: string): void {
    const car = this.cars.get(id);
    if (!car) return;
    this.scene.remove(car.group);
    car.dispose();
    this.cars.delete(id);
  }

  carIds(): string[] {
    return [...this.cars.keys()];
  }

  follow(target: CarState, speed: number, dt: number): void {
    const fx = Math.sin(target.heading);
    const fz = Math.cos(target.heading);
    const back = 8.5 + Math.min(4, Math.abs(speed) * 0.12);
    const desired = new THREE.Vector3(target.x - fx * back, 4.4 + Math.min(1.5, Math.abs(speed) * 0.05), target.z - fz * back);
    const look = new THREE.Vector3(target.x + fx * 5, 1.2, target.z + fz * 5);
    if (!this.camInit) {
      this.camPos.copy(desired);
      this.camLook.copy(look);
      this.camInit = true;
    } else {
      const k = 1 - Math.exp(-dt * 5);
      this.camPos.lerp(desired, k);
      this.camLook.lerp(look, 1 - Math.exp(-dt * 8));
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  render(): void {
    if (!this.contextLost) this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const id of [...this.cars.keys()]) this.removeCar(id);
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
  }
}
