import React, { useRef, useMemo, useEffect, Suspense } from 'react';
import logoSrc from '../assets/logo.png';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
import { MeshSurfaceSampler } from 'three-stdlib';
import * as THREE from 'three';

// ─── Shared drag state ────────────────────────────────────────────────────────
//
// Plain mutable object — no React state — so reads in useFrame never cause
// re-renders, and both ParticleSystem and BlackBox always see the same values.

const drag = {
  yaw:      0,   // accumulated horizontal offset (radians)
  pitch:    0,   // accumulated vertical offset   (radians)
  velYaw:   0,   // inertia velocity (radians / frame)
  velPitch: 0,
  active:   false,
  lastX:    0,
  lastY:    0,
};

const DRAG_SENS   = 0.004;
const DAMPING     = 0.90;
const PITCH_LIMIT = Math.PI * 0.45;

// ─── Brain mesh sampler hook ──────────────────────────────────────────────────

function useBrainTargets(count: number): Float32Array {
  const { scene } = useGLTF('/models/brain.glb');

  return useMemo(() => {
    let brainMesh: THREE.Mesh | null = null;
    scene.traverse((o) => {
      if (!brainMesh && (o as THREE.Mesh).isMesh) brainMesh = o as THREE.Mesh;
    });

    if (!brainMesh) {
      console.warn('No mesh found in brain.glb — falling back to ellipsoid');
      return new Float32Array(count * 3);
    }

    const mesh = (brainMesh as THREE.Mesh).clone();
    mesh.geometry = (brainMesh as THREE.Mesh).geometry.clone();
    mesh.updateMatrixWorld(true);

    const sampler = new MeshSurfaceSampler(mesh).build();
    const pos = new THREE.Vector3();
    const out = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      sampler.sample(pos);
      out[i * 3 + 0] = pos.x;
      out[i * 3 + 1] = pos.y;
      out[i * 3 + 2] = pos.z;
    }

    return out;
  }, [scene, count]);
}

// ─── Window-level pointer listeners (registered once) ────────────────────────
//
// Called inside ParticleSystem via useDragListeners(). BlackBox doesn't need
// to register its own — they all write to the same `drag` object.

function useDragListeners() {
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!drag.active) return;

      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;

      drag.velYaw   = dx * DRAG_SENS;
      drag.velPitch = dy * DRAG_SENS;

      drag.yaw += drag.velYaw;
      drag.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, drag.pitch + drag.velPitch));

      e.preventDefault(); // prevent scroll / text-select while dragging
    };

    const onUp = () => { drag.active = false; };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup',   onUp);
    return () => {
      window.removeEventListener('pointermove', onMove as EventListener);
      window.removeEventListener('pointerup',   onUp);
    };
  }, []);
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

// Call from any R3F onPointerDown to begin a drag
function startDrag(e: any) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  drag.active = true;
  drag.lastX  = e.clientX;
  drag.lastY  = e.clientY;
  e.target?.setPointerCapture?.(e.pointerId);
  e.stopPropagation();
}

// Advance inertia once per frame (call from whichever useFrame runs first).
// BlackBox reads drag.yaw / drag.pitch directly — no double-ticking needed.
function advanceDragInertia() {
  if (drag.active) return;
  drag.yaw   += drag.velYaw;
  drag.pitch += drag.velPitch;
  drag.pitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, drag.pitch));
  drag.velYaw   *= DAMPING;
  drag.velPitch *= DAMPING;
  if (Math.abs(drag.velYaw)   < 1e-5) drag.velYaw   = 0;
  if (Math.abs(drag.velPitch) < 1e-5) drag.velPitch = 0;
}

// ─── 2-D neural canvas (hero background) ─────────────────────────────────────

const NeuralCanvas = ({ scrollProgress }: { scrollProgress: any }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let particles: Particle[] = [];
    const count = Math.min(window.innerWidth / 10, 150);
    let mouse = { x: -1000, y: -1000 };

    const resize = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      particles = [];
      for (let i = 0; i < count; i++) particles.push(new Particle());
    };

    class Particle {
      x: number; y: number; vx: number; vy: number; size: number;
      constructor() {
        this.x    = Math.random() * canvas.width;
        this.y    = Math.random() * canvas.height;
        this.vx   = (Math.random() - 0.5) * 0.5;
        this.vy   = (Math.random() - 0.5) * 0.5;
        this.size = Math.random() * 1.5 + 0.5;
      }
      update() {
        this.x += this.vx; this.y += this.vy;
        if (this.x < 0 || this.x > canvas.width)  this.vx *= -1;
        if (this.y < 0 || this.y > canvas.height)  this.vy *= -1;
      }
      draw() {
        ctx!.beginPath();
        ctx!.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx!.fillStyle = 'rgba(255,255,255,0.4)';
        ctx!.fill();
      }
    }

    const drawConnections = () => {
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const d  = Math.sqrt(dx*dx + dy*dy);
          if (d < 150) {
            ctx.beginPath();
            ctx.strokeStyle = `rgba(255,255,255,${0.15*(1-d/150)})`;
            ctx.lineWidth = 0.5;
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.stroke();
          }
        }
        const dxM = particles[i].x - mouse.x;
        const dyM = particles[i].y - mouse.y;
        const dM  = Math.sqrt(dxM*dxM + dyM*dyM);
        if (dM < 250) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(255,230,0,${0.6*(1-dM/250)})`;
          ctx.lineWidth = 1.5;
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
          particles[i].x -= dxM * 0.015;
          particles[i].y -= dyM * 0.015;
        }
      }
    };

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => { p.update(); p.draw(); });
      drawConnections();
      animId = requestAnimationFrame(animate);
    };

    window.addEventListener('resize',    resize);
    window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
    window.addEventListener('mouseout',  ()  => { mouse.x = -1000; mouse.y = -1000; });

    resize();
    animate();
    return () => { window.removeEventListener('resize', resize); cancelAnimationFrame(animId); };
  }, []);

  const opacity = useTransform(scrollProgress, [0, 0.05, 0.15], [1, 1, 0]);
  return <motion.canvas ref={canvasRef} style={{ opacity }} className="fixed inset-0 w-full h-full z-0 bg-mf-dark" />;
};

// ─── 3-D particle system ──────────────────────────────────────────────────────

const PARTICLE_COUNT = 500000;

const ParticleSystem = ({
  scrollProgress,
  brainTargets,
}: {
  scrollProgress: any;
  brainTargets: Float32Array;
}) => {
  const groupRef    = useRef<THREE.Group>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  // Register window pointer listeners — only this component does it
  useDragListeners();

  const positions = useMemo(() => {
    const random        = new Float32Array(PARTICLE_COUNT * 3);
    const box           = new Float32Array(PARTICLE_COUNT * 3);
    const brain         = new Float32Array(PARTICLE_COUNT * 3);
    const randomOffsets = new Float32Array(PARTICLE_COUNT);
    const scale         = 5.0;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      random[i3]     = (Math.random() - 0.5) * 50;
      random[i3 + 1] = (Math.random() - 0.5) * 50;
      random[i3 + 2] = (Math.random() - 0.5) * 50;
      box[i3]        = (Math.random() - 0.5) * 5.1;
      box[i3 + 1]    = (Math.random() - 0.5) * 5.1;
      box[i3 + 2]    = (Math.random() - 0.5) * 5.1;
      brain[i3]      = brainTargets[i3]     * scale;
      brain[i3 + 1]  = brainTargets[i3 + 1] * scale;
      brain[i3 + 2]  = brainTargets[i3 + 2] * scale;
      randomOffsets[i] = Math.random() * Math.PI * 2;
    }

    return { random, box, brain, randomOffsets };
  }, [brainTargets]);

  const shaderArgs = useMemo(() => ({
    uniforms: {
      uScroll: { value: 0 },
      uTime:   { value: 0 },
      uColor:  { value: new THREE.Color('#FFFFFF') },
    },
    vertexShader: `
      attribute vec3 aBox;
      attribute vec3 aBrain;
      attribute float aOffset;
      uniform float uScroll;
      uniform float uTime;
      varying float vAlpha;
      varying float vPulse;

      void main() {
        vec3 pos = position;

        float t1 = smoothstep(0.1, 0.3, uScroll);
        pos = mix(pos, aBox, t1);

        float t2 = smoothstep(0.5, 0.7, uScroll);
        pos = mix(pos, aBrain, t2);

        pos.y += sin(uTime * 1.5 + aOffset) * 0.2 * (1.0 - t1 * 0.9);
        pos.x += cos(uTime * 1.0 + aOffset) * 0.1 * (1.0 - t1 * 0.9);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        float baseSize = mix(20.0, 10.0, t1);
        baseSize = mix(baseSize, 15.0, t2);
        vPulse = sin(uTime * 3.0 + aOffset) * 0.5 + 0.5;
        baseSize += vPulse * 4.0;
        gl_PointSize = baseSize / -mvPosition.z;

        vAlpha = mix(0.4, 0.8, t1);
        vAlpha = mix(vAlpha, 0.6, t2);
        float introFade = smoothstep(0.05, 0.15, uScroll);
        vAlpha *= introFade;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vAlpha;
      varying float vPulse;

      void main() {
        vec2 xy = gl_PointCoord.xy - vec2(0.5);
        float ll = length(xy);
        if (ll > 0.5) discard;
        float alpha = smoothstep(0.5, 0.1, ll) * vAlpha;
        alpha += smoothstep(0.5, 0.0, ll) * vPulse * 0.5 * vAlpha;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }), []);

  useFrame((state) => {
    const s = scrollProgress.get();

    if (materialRef.current) {
      materialRef.current.uniforms.uScroll.value = s;
      materialRef.current.uniforms.uTime.value   = state.clock.elapsedTime;
    }

    // ParticleSystem advances inertia — BlackBox will just read drag.yaw/pitch
    advanceDragInertia();

    if (groupRef.current) {
      groupRef.current.rotation.y = state.clock.elapsedTime * 0.05 + s * Math.PI * 2 + drag.yaw;
      groupRef.current.rotation.x = s * Math.PI * 0.5 + drag.pitch;
    }
  });

  return (
    <group ref={groupRef} onPointerDown={startDrag}>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position"  count={PARTICLE_COUNT} array={positions.random}        itemSize={3} />
          <bufferAttribute attach="attributes-aBox"      count={PARTICLE_COUNT} array={positions.box}           itemSize={3} />
          <bufferAttribute attach="attributes-aBrain"    count={PARTICLE_COUNT} array={positions.brain}         itemSize={3} />
          <bufferAttribute attach="attributes-aOffset"   count={PARTICLE_COUNT} array={positions.randomOffsets} itemSize={1} />
        </bufferGeometry>
        <shaderMaterial ref={materialRef} args={[shaderArgs]} />
      </points>
    </group>
  );
};

// ─── Wrapper that loads brain targets then renders particles ──────────────────

const BrainParticleSystem = ({ scrollProgress }: { scrollProgress: any }) => {
  const brainTargets = useBrainTargets(PARTICLE_COUNT);
  return <ParticleSystem scrollProgress={scrollProgress} brainTargets={brainTargets} />;
};

// ─── Black box ────────────────────────────────────────────────────────────────

const BlackBox = ({ scrollProgress }: { scrollProgress: any }) => {
  const groupRef    = useRef<THREE.Group>(null);
  const solidMatRef = useRef<THREE.MeshPhysicalMaterial>(null);
  const wireMatRef  = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(() => {
    const s = scrollProgress.get();

    let opacity = 0;
    if (s > 0.1 && s <= 0.3)       opacity = (s - 0.1) / 0.2;
    else if (s > 0.3 && s <= 0.4)  opacity = 1;
    else if (s > 0.4 && s <= 0.5)  opacity = 1 - (s - 0.4) / 0.1;

    let scale = 1;
    if (s > 0.4 && s <= 0.5) scale = 1 + ((s - 0.4) / 0.1) * 0.8;

    if (groupRef.current) {
      groupRef.current.scale.set(scale, scale, scale);
      // Mirror ParticleSystem's rotation exactly — same scroll base + same drag offset.
      // advanceDragInertia() has already been called this frame by ParticleSystem,
      // so we just read the already-updated drag.yaw / drag.pitch values.
      groupRef.current.rotation.y = s * Math.PI * 2 + drag.yaw;
      groupRef.current.rotation.x = s * Math.PI * 0.5 + drag.pitch;
    }

    if (solidMatRef.current) {
      solidMatRef.current.opacity = opacity * 0.95;
      solidMatRef.current.visible = opacity > 0;
    }
    if (wireMatRef.current) {
      wireMatRef.current.opacity = opacity * 0.3;
      wireMatRef.current.visible = opacity > 0;
    }
  });

  return (
    // Dragging on the box itself also works — writes to the same drag object
    <group ref={groupRef} onPointerDown={startDrag}>
      <mesh>
        <boxGeometry args={[6.2, 6.2, 6.2]} />
        <meshPhysicalMaterial ref={solidMatRef} color="#020202" metalness={0.9} roughness={0.1} transparent depthWrite={false} />
      </mesh>
      <mesh>
        <boxGeometry args={[6.21, 6.21, 6.21]} />
        <meshBasicMaterial ref={wireMatRef} color="#FFE600" wireframe transparent />
      </mesh>
    </group>
  );
};

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  const smoothProgress = useSpring(scrollYProgress, {
    stiffness: 50,
    damping: 15,
    restDelta: 0.001,
  });

  const t1Opacity = useTransform(smoothProgress, [0,    0.05, 0.15],        [1, 1, 0]);
  const t2Opacity = useTransform(smoothProgress, [0.2,  0.25, 0.35, 0.45],  [0, 1, 1, 0]);
  const t3Opacity = useTransform(smoothProgress, [0.55, 0.65, 1],           [0, 1, 1]);

  return (
    <div ref={containerRef} className="relative h-[500vh] bg-mf-dark text-white selection:bg-mf-yellow selection:text-black font-sans">

      <NeuralCanvas scrollProgress={smoothProgress} />

      {/* pointer-events-auto so clicks on the canvas register for drag */}
      <div className="fixed inset-0 z-0 pointer-events-auto">
        <Canvas camera={{ position: [0, 0, 15], fov: 45 }}>
          <ambientLight intensity={0.5} />
          <directionalLight position={[10, 10, 10]} intensity={2} />
          <Suspense fallback={null}>
            <BrainParticleSystem scrollProgress={smoothProgress} />
          </Suspense>
          <BlackBox scrollProgress={smoothProgress} />
        </Canvas>
      </div>

      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 p-6 md:p-10 flex justify-between items-center pointer-events-none">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.5 }}
          className="flex items-center gap-4 pointer-events-auto"
        >
          <img
            src={logoSrc}
            alt="MindFlow Logo"
            className="w-10 h-10 object-contain"
            style={{ filter: 'brightness(0) invert(1)' }}
            onError={(e) => {
              e.currentTarget.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='40' fill='white'/%3E%3C/svg%3E";
            }}
          />
          <span className="font-display font-bold text-xl tracking-widest uppercase">MindFlow</span>
        </motion.div>
      </header>

      {/* Text overlays */}
      <div className="sticky top-0 left-0 w-full h-screen overflow-hidden flex items-center justify-center pointer-events-none z-10">

        {/* Stage 1 */}
        <motion.div style={{ opacity: t1Opacity }} className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
          <h1 className="text-6xl md:text-[8rem] lg:text-[12rem] font-display font-bold tracking-tighter leading-none mb-8 text-transparent bg-clip-text bg-gradient-to-b from-white via-white to-white/30 drop-shadow-2xl">
            MindFlow
          </h1>
          <p className="text-lg md:text-2xl font-light tracking-wide text-white/60 max-w-2xl text-center leading-relaxed">
            Decode Your Mind, Power Your World.<br className="hidden md:block" />
            <span className="text-white font-medium">Non-invasive brain-machine symbiosis.</span>
          </p>
        </motion.div>

        {/* Stage 2 */}
        <motion.div style={{ opacity: t2Opacity }} className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
          <h2 className="text-4xl md:text-6xl lg:text-8xl font-display font-bold tracking-tighter leading-none text-white drop-shadow-2xl">
            The mind is a <span className="text-mf-yellow">black box.</span>
          </h2>
        </motion.div>

        {/* Stage 3 */}
        <motion.div style={{ opacity: t3Opacity }} className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
          <h2 className="text-4xl md:text-6xl lg:text-8xl font-display font-bold tracking-tighter leading-none text-white drop-shadow-2xl mb-6">
            We exist to <span className="text-mf-yellow">uncover it.</span>
          </h2>
          <p className="text-lg md:text-xl font-light tracking-wide text-white/60 max-w-xl text-center leading-relaxed">
            A brain OS layer that captures, interprets, and operationalizes your brain signals.
          </p>
        </motion.div>

      </div>

      {/* Scroll indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.5, delay: 2 }}
        className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-4 pointer-events-none"
      >
        <span className="text-[10px] uppercase tracking-[0.4em] text-white/40 font-medium">Scroll</span>
        <div className="w-[1px] h-16 bg-gradient-to-b from-white/30 to-transparent"></div>
      </motion.div>

    </div>
  );
}