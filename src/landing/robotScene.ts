import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

/**
 * The boxy ceramic robot behind the landing page.
 * Fixed full-screen transparent canvas; camera and pose are driven by scroll + pointer.
 * Returns a dispose function.
 */
export function createRobotScene(canvas: HTMLCanvasElement): () => void {
  // ---------- renderer / env / camera ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const roomEnv = new RoomEnvironment(renderer)
  const envRT = pmrem.fromScene(roomEnv, 0.04)
  scene.environment = envRT.texture
  const ENV_INTENSITY = 0.9

  const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 100)

  // ---------- lights ----------
  scene.add(new THREE.HemisphereLight(0xfff6ee, 0xd9d2c8, 0.7))
  const key = new THREE.DirectionalLight(0xfff3e6, 1.7)
  key.position.set(-3, 5, 4)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.radius = 6
  key.shadow.bias = -0.0005
  const sc = key.shadow.camera
  sc.left = -4
  sc.right = 4
  sc.top = 4
  sc.bottom = -4
  sc.near = 0.5
  sc.far = 20
  scene.add(key)
  const rim = new THREE.DirectionalLight(0xfff0e6, 1.2)
  rim.position.set(4, 2, -4)
  scene.add(rim)
  const fill = new THREE.PointLight(0xff9a6a, 2.2, 6)
  fill.position.set(-3.2, 1.2, 0.6)
  scene.add(fill)

  // ---------- materials ----------
  const shell = new THREE.MeshPhysicalMaterial({
    color: 0xeeebe6,
    roughness: 0.38,
    clearcoat: 0.45,
    clearcoatRoughness: 0.3,
    envMapIntensity: ENV_INTENSITY,
  })
  const shellLight = new THREE.MeshPhysicalMaterial({
    color: 0xf8f6f2,
    roughness: 0.34,
    clearcoat: 0.45,
    clearcoatRoughness: 0.3,
    envMapIntensity: ENV_INTENSITY,
  })
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.55, metalness: 0.3, envMapIntensity: ENV_INTENSITY })
  const deep = new THREE.MeshStandardMaterial({ color: 0x0f0f12, roughness: 0.5, metalness: 0.2, envMapIntensity: ENV_INTENSITY })
  const pedestalMat = new THREE.MeshStandardMaterial({ color: 0x2a2928, roughness: 0.9, envMapIntensity: ENV_INTENSITY })

  // gradient ring texture (conic)
  const ringCanvas = document.createElement('canvas')
  ringCanvas.width = ringCanvas.height = 512
  {
    const g = ringCanvas.getContext('2d')!
    const grad = g.createConicGradient(0, 256, 256)
    const stops: [number, string][] = [
      [0, '#ff3d8b'],
      [1 / 6, '#ff5a5f'],
      [2 / 6, '#ff8a3d'],
      [3 / 6, '#ffb347'],
      [4 / 6, '#ff8a3d'],
      [5 / 6, '#ff5a5f'],
      [1, '#ff3d8b'],
    ]
    stops.forEach(([o, c]) => grad.addColorStop(o, c))
    g.fillStyle = grad
    g.fillRect(0, 0, 512, 512)
  }
  const ringTex = new THREE.CanvasTexture(ringCanvas)
  ringTex.colorSpace = THREE.SRGBColorSpace
  const ringMat = new THREE.MeshPhysicalMaterial({
    map: ringTex,
    emissive: 0xffffff,
    emissiveMap: ringTex,
    emissiveIntensity: 0.22,
    roughness: 0.5,
    clearcoat: 0.35,
    envMapIntensity: ENV_INTENSITY,
  })

  // face screen canvas
  const faceCanvas = document.createElement('canvas')
  faceCanvas.width = faceCanvas.height = 512
  const fctx = faceCanvas.getContext('2d')!
  const faceTex = new THREE.CanvasTexture(faceCanvas)
  faceTex.colorSpace = THREE.SRGBColorSpace
  const screenMat = new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    roughness: 0.12,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    emissive: 0xffffff,
    emissiveMap: faceTex,
    emissiveIntensity: 1.6,
    envMapIntensity: ENV_INTENSITY,
  })

  // ---------- helpers ----------
  const shadowed = (m: THREE.Mesh) => {
    m.castShadow = true
    m.receiveShadow = true
    return m
  }
  const rbox = (w: number, h: number, d: number, r: number, mat: THREE.Material) =>
    shadowed(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, r), mat))
  const ball = (r: number, mat: THREE.Material) => shadowed(new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), mat))
  const roundedRectShape = (w: number, h: number, r: number) => {
    const s = new THREE.Shape()
    const x = -w / 2
    const y = -h / 2
    s.moveTo(x + r, y)
    s.lineTo(x + w - r, y)
    s.quadraticCurveTo(x + w, y, x + w, y + r)
    s.lineTo(x + w, y + h - r)
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    s.lineTo(x + r, y + h)
    s.quadraticCurveTo(x, y + h, x, y + h - r)
    s.lineTo(x, y + r)
    s.quadraticCurveTo(x, y, x + r, y)
    return s
  }
  const frameGeometry = (ow: number, oh: number, or: number, iw: number, ih: number, ir: number, depth: number, bevel: number) => {
    const shape = roundedRectShape(ow, oh, or)
    shape.holes.push(roundedRectShape(iw, ih, ir))
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 3,
      curveSegments: 16,
    })
    remapUVToBounds(geo)
    return geo
  }
  /** Planar-map UVs to the geometry's XY bounds so a texture wraps the whole frame. */
  function remapUVToBounds(geo: THREE.BufferGeometry) {
    geo.computeBoundingBox()
    const bb = geo.boundingBox!
    const pos = geo.attributes.position
    const uv = geo.attributes.uv
    const w = bb.max.x - bb.min.x
    const h = bb.max.y - bb.min.y
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, (pos.getX(i) - bb.min.x) / w, (pos.getY(i) - bb.min.y) / h)
    }
    uv.needsUpdate = true
  }

  // ---------- build ----------
  const robot = new THREE.Group()
  scene.add(robot)
  const body = new THREE.Group()
  robot.add(body)

  // torso
  body.add(rbox(1.22, 1.12, 0.92, 0.24, shell))
  const chestTop = rbox(1.0, 0.14, 0.72, 0.06, shellLight)
  chestTop.position.set(0, 0.56, 0)
  body.add(chestTop)
  ;[0xff8a3d, 0xff5a5f, 0xff3d8b].forEach((c, i) => {
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.038, 16, 12),
      new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 2.2, roughness: 0.3 }),
    )
    led.position.set(-0.15 + i * 0.15, 0.3, 0.47)
    body.add(led)
  })
  for (const s of [-1, 1]) {
    const slot = rbox(0.08, 0.32, 0.05, 0.02, deep)
    slot.position.set(s * 0.24, -0.14, 0.45)
    body.add(slot)
    const lip = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.018, 8, 20, Math.PI), dark))
    lip.position.set(s * 0.24, 0.04, 0.46)
    body.add(lip)
  }
  const pelvis = rbox(0.84, 0.22, 0.66, 0.08, dark)
  pelvis.position.set(0, -0.6, 0)
  body.add(pelvis)

  // neck
  const neck = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.36, 24), dark))
  neck.position.set(0, 0.74, 0)
  body.add(neck)

  // head (pivot at y .78, head centre +.78 above the pivot)
  const headPivot = new THREE.Group()
  headPivot.position.set(0, 0.78, 0)
  body.add(headPivot)
  const head = new THREE.Group()
  head.position.set(0, 0.78, 0)
  headPivot.add(head)

  head.add(rbox(1.5, 1.42, 1.3, 0.2, shell))
  const back = rbox(1.28, 1.14, 0.9, 0.1, deep)
  back.position.set(0, 0, -0.32)
  head.add(back)
  {
    // tiny "circuit" bars scattered over the back block's back and top (seeded, deterministic)
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 26; i++) {
      const onTop = i % 3 === 0
      const len = 0.08 + rnd() * 0.22
      const horiz = rnd() > 0.5
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(horiz ? len : 0.025, onTop ? 0.02 : horiz ? 0.025 : len, onTop ? (horiz ? 0.025 : len) : 0.02),
        dark,
      )
      if (onTop) bar.position.set((rnd() - 0.5) * 1.0, 0.575, -0.32 + (rnd() - 0.5) * 0.6)
      else bar.position.set((rnd() - 0.5) * 1.0, (rnd() - 0.5) * 0.9, -0.78)
      bar.castShadow = true
      head.add(bar)
    }
  }
  const ring = shadowed(new THREE.Mesh(frameGeometry(1.5, 1.44, 0.3, 1.08, 1.02, 0.2, 0.1, 0.03), ringMat))
  ring.position.z = 0.6
  head.add(ring)
  const bezel = shadowed(new THREE.Mesh(frameGeometry(1.1, 1.04, 0.21, 0.92, 0.86, 0.15, 0.04, 0.012), shellLight))
  bezel.position.z = 0.62
  head.add(bezel)
  {
    const g = new THREE.ShapeGeometry(roundedRectShape(0.9, 0.84, 0.14), 16)
    remapUVToBounds(g)
    const screen = new THREE.Mesh(g, screenMat)
    screen.position.z = 0.66
    head.add(screen)
  }
  for (const s of [-1, 1]) {
    const ear = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 28), dark))
    ear.rotation.z = Math.PI / 2
    ear.position.set(s * 0.8, 0, -0.05)
    head.add(ear)
    const cap = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 28), shellLight))
    cap.rotation.z = Math.PI / 2
    cap.position.set(s * 0.88, 0, -0.05)
    head.add(cap)
  }
  {
    // cable looping down from the right ear
    // half-torus in the YZ plane, flipped so the arc hangs below the ear
    const cableGroup = new THREE.Group()
    cableGroup.rotation.y = Math.PI / 2
    cableGroup.position.set(0.9, -0.05, -0.33)
    const cable = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.032, 10, 32, Math.PI), dark))
    cable.rotation.z = Math.PI
    cableGroup.add(cable)
    head.add(cableGroup)
  }

  // arms
  const arms: { shoulder: THREE.Group; forearm: THREE.Group; side: number }[] = []
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group()
    shoulder.position.set(s * 0.74, 0.36, 0)
    shoulder.rotation.z = s * 0.16
    body.add(shoulder)
    shoulder.add(ball(0.17, dark))
    const upper = rbox(0.26, 0.5, 0.3, 0.1, shell)
    upper.position.y = -0.33
    shoulder.add(upper)
    const elbow = ball(0.1, dark)
    elbow.position.y = -0.62
    shoulder.add(elbow)
    const forearm = new THREE.Group()
    forearm.position.y = -0.62
    forearm.rotation.x = -0.35
    shoulder.add(forearm)
    const hand = rbox(0.28, 0.36, 0.32, 0.1, shellLight)
    hand.position.y = -0.27
    forearm.add(hand)
    const thumb = rbox(0.08, 0.16, 0.1, 0.035, shellLight)
    thumb.position.set(-s * 0.16, -0.2, 0.06)
    forearm.add(thumb)
    arms.push({ shoulder, forearm, side: s })
  }

  // legs
  for (const s of [-1, 1]) {
    const hip = ball(0.13, dark)
    hip.position.set(s * 0.3, -0.74, 0)
    body.add(hip)
    const leg = rbox(0.34, 0.42, 0.4, 0.1, shell)
    leg.position.set(s * 0.3, -1.0, 0)
    body.add(leg)
    const ankle = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 18), dark))
    ankle.position.set(s * 0.3, -1.25, 0)
    body.add(ankle)
    const foot = rbox(0.42, 0.14, 0.6, 0.06, shellLight)
    foot.position.set(s * 0.3, -1.35, 0.06)
    body.add(foot)
  }

  // pedestal
  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.6, 1.7), pedestalMat)
  pedestal.position.y = -2.22
  pedestal.receiveShadow = true
  robot.add(pedestal)

  // ---------- face drawing ----------
  let faceMode: 'eyes' | 'quote' = 'eyes'
  let faceAlpha = 1
  let blink = 1 // vertical eye scale
  let blinkStart = -1
  let nextBlink = performance.now() + 2500 + Math.random() * 3000

  function drawFace(now: number) {
    if (blinkStart < 0 && now >= nextBlink) blinkStart = now
    if (blinkStart >= 0) {
      const t = (now - blinkStart) / 180
      if (t >= 1) {
        blink = 1
        blinkStart = -1
        nextBlink = now + 2500 + Math.random() * 3000
      } else {
        blink = 1 - 0.9 * Math.sin(t * Math.PI) // squash to 10% and back
      }
    }
    if (faceAlpha < 1) faceAlpha = Math.min(1, faceAlpha + 0.05)

    fctx.globalAlpha = 1
    fctx.shadowBlur = 0
    fctx.fillStyle = '#000'
    fctx.fillRect(0, 0, 512, 512)
    fctx.globalAlpha = faceAlpha
    fctx.fillStyle = '#fff'
    fctx.shadowColor = '#fff'
    fctx.shadowBlur = 18
    if (faceMode === 'eyes') {
      for (const [x, y] of [
        [196, 262],
        [316, 252],
      ]) {
        fctx.beginPath()
        fctx.ellipse(x, y, 30, 38 * blink, 0, 0, Math.PI * 2)
        fctx.fill()
      }
    } else {
      fctx.font = '560px "Arial Black", "Arial", sans-serif'
      fctx.textAlign = 'center'
      fctx.textBaseline = 'middle'
      fctx.fillText('“', 256, 400)
    }
    faceTex.needsUpdate = true
  }

  // ---------- input ----------
  let targetP = 0
  let p = 0
  const pointer = { x: 0, y: 0 }
  const pointerS = { x: 0, y: 0 }
  const onScroll = () => {
    targetP = Math.min(2, Math.max(0, window.scrollY / window.innerHeight))
  }
  const onPointer = (e: PointerEvent) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1
  }
  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight, false)
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('pointermove', onPointer, { passive: true })
  window.addEventListener('resize', onResize)
  onResize()
  onScroll()
  p = targetP

  // ---------- states ----------
  const INTRO = { camZ: 11.6, camY: 1.1, lookY: 0.55, bodyYaw: -0.42, headYaw: -0.6, headPitch: 0.16, headRoll: 0.22 }
  const PRODUCT = { camZ: 6.9, camY: 1.95, lookY: 1.72, bodyYaw: -0.2, headYaw: -0.06, headPitch: 0.04, headRoll: 0 }
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

  const clock = new THREE.Clock()
  let raf = 0
  const tick = () => {
    raf = requestAnimationFrame(tick)
    const t = clock.getElapsedTime()
    const now = performance.now()

    p += (targetP - p) * 0.08
    pointerS.x += (pointer.x - pointerS.x) * 0.06
    pointerS.y += (pointer.y - pointerS.y) * 0.06

    const k = easeInOutCubic(Math.min(1, Math.max(0, p)))
    const s = Object.fromEntries(
      Object.keys(INTRO).map((key) => [key, lerp(INTRO[key as keyof typeof INTRO], PRODUCT[key as keyof typeof PRODUCT], k)]),
    ) as typeof INTRO

    const mobile = window.innerWidth < 900
    camera.position.set(pointerS.x * 0.25, s.camY - pointerS.y * 0.1, s.camZ * (mobile ? 1.25 : 1))
    camera.lookAt(0, s.lookY, 0)

    body.position.y = Math.sin(1.4 * t) * 0.02
    body.rotation.y = s.bodyYaw + pointerS.x * 0.12
    headPivot.rotation.set(
      s.headPitch + pointerS.y * 0.18 + Math.sin(0.9 * t) * 0.02,
      s.headYaw + pointerS.x * 0.45,
      s.headRoll + Math.sin(0.7 * t) * 0.02,
      'YXZ',
    )
    for (const a of arms) {
      a.shoulder.rotation.x = Math.sin(1.4 * t + a.side) * 0.05
      a.forearm.rotation.x = -0.35 + Math.sin(1.4 * t + a.side) * 0.06
    }

    const wantMode = p > 1.55 ? 'quote' : 'eyes'
    if (wantMode !== faceMode) {
      faceMode = wantMode
      faceAlpha = 0
    }
    drawFace(now)

    renderer.render(scene, camera)
  }
  tick()

  return () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('scroll', onScroll)
    window.removeEventListener('pointermove', onPointer)
    window.removeEventListener('resize', onResize)
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    ;[shell, shellLight, dark, deep, pedestalMat, ringMat, screenMat].forEach((m) => m.dispose())
    ringTex.dispose()
    faceTex.dispose()
    envRT.dispose()
    roomEnv.dispose()
    pmrem.dispose()
    renderer.dispose()
  }
}
