'use client';

/**
 * iye-frontend/components/VectorCanvas.tsx
 * ─────────────────────────────────────────
 * Visual flagship component.
 *
 * Renderer priority cascade
 * ─────────────────────────
 *   1. WebGPU  (Three.js WebGPURenderer)       — navigator.gpu present
 *   2. WebGL 2 with EXT_color_buffer_float       — desktop fallback
 *   3. WebGL 1 minimal                           — last resort
 *
 * The resolved tier is written to data-renderer-tier on the mount div
 * and also pushed into the parent via onTierResolved().
 *
 * Frame is consumed as a prop — useVectorField is lifted to the parent page
 * so connection state (streamStatus) is visible at the page layer.
 *
 * Per-frame update
 * ────────────────
 *   A single THREE.InstancedMesh of cone geometry (1 per vector) is
 *   updated inside useFrame(). For each instance we set:
 *     • position    — spatial origin coordinates (ox, oy, oz)
 *     • quaternion  — pointing along the direction vector (vx, vy, vz)
 *     • scale       — proportional to velocity magnitude
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { FieldFrame } from '../hooks/useVectorField';

// ── Design tokens ─────────────────────────────────────────────────────────────

const COLOR_NOMINAL = new THREE.Color('#7A9A82'); // muted sage green
const COLOR_HEALED  = new THREE.Color('#C4A882'); // warm amber — visual alert
const CONE_H        = 0.18;
const CONE_R        = 0.045;
const CONE_SEGS     = 7;
const MAX_INSTANCES = 512;

// ── Renderer tier detection ───────────────────────────────────────────────────

export type RendererTier = 'webgpu' | 'webgl2' | 'webgl1' | 'detecting';

async function detectRendererTier(): Promise<RendererTier> {
  // ── Tier 1: WebGPU ──────────────────────────────────────────────────────
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch {
      // adapter unavailable — fall through
    }
  }

  // ── Tier 2: WebGL 2 + float textures ───────────────────────────────────
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    if (gl2) {
      const floatExt = gl2.getExtension('EXT_color_buffer_float');
      canvas.remove();
      if (floatExt) return 'webgl2';
    } else {
      canvas.remove();
    }
  } catch {
    // context creation failed — fall through
  }

  // ── Tier 3: WebGL 1 minimal ─────────────────────────────────────────────
  return 'webgl1';
}

// ── Shared quaternion scratch objects (avoid allocation in hot loop) ──────────

const _up    = new THREE.Vector3(0, 1, 0);
const _dir   = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _mat   = new THREE.Matrix4();
const _pos   = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _zero  = new THREE.Matrix4().makeScale(0, 0, 0);

function buildInstanceMatrix(
  ox: number, oy: number, oz: number,
  vx: number, vy: number, vz: number,
  magnitude: number,
  out: THREE.Matrix4,
): void {
  const s = Math.max(0.3, Math.min(magnitude * 0.8, 2.5));

  // Position: draw at the precise geometric origin
  _pos.set(ox, oy, oz);

  // Quaternion: rotate +Y axis onto the direction vector
  _dir.set(vx, vy, vz);
  const len = _dir.length();
  if (len < 1e-9) {
    _dir.set(1e-6, 0, 0);
  } else {
    _dir.divideScalar(len);
  }
  _quat.setFromUnitVectors(_up, _dir);

  _scale.set(s * 0.6, s * 1.5, s * 0.6); // slight elongation along direction axis
  out.compose(_pos, _quat, _scale);
}

// ── Inner Three.js field mesh ─────────────────────────────────────────────────

interface FieldMeshProps {
  frame: FieldFrame | null;
}

function FieldMesh({ frame }: FieldMeshProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  // Geometry and material are memoised — not rebuilt per frame
  const geometry = useMemo(
    () => new THREE.ConeGeometry(CONE_R, CONE_H, CONE_SEGS),
    [],
  );
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color:       COLOR_NOMINAL,
        roughness:   0.55,
        metalness:   0.35,
        transparent: true,
        opacity:     0.92,
      }),
    [],
  );

  useFrame(() => {
    if (!meshRef.current || !frame) return;

    const vectors = frame.vectors;
    const n       = Math.min(vectors.length, MAX_INSTANCES);

    // Tint color based on stream health status
    material.color.copy(
      frame.status === 'healed' ? COLOR_HEALED : COLOR_NOMINAL
    );

    for (let i = 0; i < n; i++) {
      const vec = vectors[i];
      const [ox, oy, oz] = vec.origin;
      const [vx, vy, vz] = vec.direction;
      buildInstanceMatrix(ox, oy, oz, vx, vy, vz, vec.magnitude, _mat);
      meshRef.current.setMatrixAt(i, _mat);
    }

    // Collapse any unused slots beyond the current frame count
    for (let i = n; i < meshRef.current.count; i++) {
      meshRef.current.setMatrixAt(i, _zero);
    }

    meshRef.current.instanceMatrix.needsUpdate = true;
    meshRef.current.count = n;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_INSTANCES]}
      frustumCulled={false}
    />
  );
}

// ── Scene content ─────────────────────────────────────────────────────────────

function SceneContent({ frame }: { frame: FieldFrame | null }) {
  return (
    <>
      {/* Lighting — ambient + key + fill + rim */}
      <ambientLight intensity={0.22} color="#1a2030" />
      <directionalLight
        position={[8, 12, 6]}
        intensity={1.9}
        color="#d0e4ff"
        castShadow={false}
      />
      <pointLight position={[-6, -6, 4]}  intensity={0.65} color="#7A9A82" />
      <pointLight position={[0,  10, -8]} intensity={0.40} color="#334455" />

      {/* Reference grid */}
      <gridHelper
        args={[22, 44, '#1e2530', '#1a1e25']}
        position={[0, -5, 0]}
      />

      {/* Vector field */}
      <FieldMesh frame={frame} />

      {/* Orbital camera — slow auto-rotate for ambient motion */}
      <OrbitControls
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        autoRotate={true}
        autoRotateSpeed={0.35}
        minDistance={3}
        maxDistance={32}
        dampingFactor={0.07}
        enableDamping={true}
      />
    </>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

interface VectorCanvasProps {
  /** Pre-resolved frame from the parent's useVectorField call. */
  frame:             FieldFrame | null;
  streamStatus:      'connecting' | 'live' | 'healed' | 'mock';
  onTierResolved?:   (tier: RendererTier) => void;
  className?:        string;
}

export default function VectorCanvas({
  frame,
  streamStatus,
  onTierResolved,
  className = '',
}: VectorCanvasProps) {
  const [tier,    setTier]    = useState<RendererTier>('detecting');
  const mountRef              = useRef<HTMLDivElement>(null);

  // Detect renderer capability once on mount
  useEffect(() => {
    detectRendererTier().then((resolved) => {
      setTier(resolved);
      onTierResolved?.(resolved);
      if (mountRef.current) {
        mountRef.current.setAttribute('data-renderer-tier', resolved);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive connection styling
  const isLive = streamStatus === 'live' || streamStatus === 'healed';
  const isMock = streamStatus === 'mock';
  
  const statusColor = isLive ? '#7A9A82' : isMock ? '#C4A882' : '#556677';
  const statusIndicatorBg = isLive ? '#7A9A82' : isMock ? '#C4A882' : '#334455';
  
  let label = 'connecting…';
  if (streamStatus === 'live') label = 'live stream';
  if (streamStatus === 'healed') label = 'healed stream';
  if (streamStatus === 'mock') label = 'mock mode';

  return (
    <div
      ref={mountRef}
      className={`relative w-full h-full ${className}`}
      data-renderer-tier={tier}
      style={{ background: '#121417' }}
    >
      <Canvas
        camera={{ position: [0, 3, 12], fov: 55, near: 0.1, far: 500 }}
        gl={{
          antialias:       tier !== 'webgl1',
          alpha:           false,
          powerPreference: 'high-performance',
        }}
        dpr={[1, tier === 'webgpu' ? 2 : 1.5]}
        style={{ background: '#121417' }}
      >
        <SceneContent frame={frame} />
      </Canvas>

      {/* Connection status badge — bottom left */}
      <div
        className="absolute bottom-4 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full"
        style={{
          background:     'rgba(18,20,23,0.80)',
          border:         '1px solid rgba(122,154,130,0.22)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          color:          statusColor,
          fontSize:       11,
          letterSpacing:  '0.07em',
          fontFamily:     'ui-monospace, monospace',
        }}
      >
        <span
          style={{
            width:        6,
            height:       6,
            borderRadius: '50%',
            background:   statusIndicatorBg,
            display:      'inline-block',
            flexShrink:   0,
            boxShadow:    isLive
              ? '0 0 7px #7A9A82'
              : isMock
              ? '0 0 7px #C4A882'
              : 'none',
          }}
        />
        {label}
      </div>
    </div>
  );
}
