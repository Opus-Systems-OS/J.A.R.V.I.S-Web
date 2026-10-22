// The Projects tab's 3D viewer: a model (.glb, .gltf or .stl) that slowly
// spins in the HUD's light; drag to turn it, scroll to zoom. three.js loads
// with the first model opened, so the HUD itself never carries it. The bytes
// come from this origin (a repo file or a Jarvis output), never a URL.

export type ModelKind = "glb" | "gltf" | "stl";

/** `suit.GLB` → "glb"; anything else → null. */
export function modelKind(name: string): ModelKind | null {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext === "glb" || ext === "gltf" || ext === "stl" ? ext : null;
}

/** Show `data` in `host`; resolves with a function that tears it all down. */
export async function showModel(host: HTMLElement, data: ArrayBuffer, kind: ModelKind): Promise<() => void> {
  const THREE = await import("three");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");

  let object: import("three").Object3D;
  if (kind === "stl") {
    const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
    const geometry = new STLLoader().parse(data);
    geometry.computeVertexNormals();
    object = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xffb25c, metalness: 0.35, roughness: 0.45, emissive: 0x3a1400 }),
    );
  } else {
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    // shortcut: a .gltf must embed its buffers and textures; one that points at side files fails to load. Upgrade by relaying those files too if repos use them.
    const gltf = await new GLTFLoader().parseAsync(data, "");
    object = gltf.scene;
  }

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffd9a8, 0x1a0800, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff7a1a, 1.4);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  // Centre it and back the camera off until the whole thing fits.
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  object.position.sub(box.getCenter(new THREE.Vector3()));
  const pivot = new THREE.Group();
  pivot.add(object);
  scene.add(pivot);
  const radius = Math.max(size.x, size.y, size.z, 1e-6) / 2;
  const camera = new THREE.PerspectiveCamera(40, 1, radius / 100, radius * 100);
  const distance = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.15;
  camera.position.set(distance * 0.6, distance * 0.35, distance * 0.75);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // The buffer is sized below; the canvas itself just fills its host.
  Object.assign(renderer.domElement.style, { display: "block", width: "100%", height: "100%" });
  host.replaceChildren(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.6;
  controls.enablePan = false;

  const fit = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const resize = new ResizeObserver(fit);
  resize.observe(host);
  fit();

  let raf = 0;
  const frame = () => {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  frame();

  return () => {
    cancelAnimationFrame(raf);
    resize.disconnect();
    controls.dispose();
    scene.traverse((o) => {
      const mesh = o as import("three").Mesh;
      mesh.geometry?.dispose();
      const m = mesh.material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.dispose();
    });
    renderer.dispose();
    renderer.domElement.remove();
  };
}
