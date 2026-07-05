import { useEffect, useRef, useState, useMemo } from 'react';
import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Line } from '@react-three/drei';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { useVectorStream, DEFAULT_TEMPORAL_METRICS, HOT_REGIMES } from './math/useVectorStream';
import type { TemporalMetrics } from './math/useVectorStream';

// ─── Design Tokens ────────────────────────────────────────────────────────────

const COLORS = {
    pink: '#ffb6c1',
    cyan: '#5fd9e8',
    anomaly: '#ff2b3d',
    tracer: '#7fd8e6',
} as const;

const BOUNDS_HALF_EXTENT = 2; // matches ViewportWireframe's boxGeometry args [4, 4, 4]

// Beacon pulse ranges — escalating anomalies pulse faster and harder, decaying ones settle.
const BASE_PULSE_HZ = 1.0;
const MAX_PULSE_HZ = 4.0;
const VELOCITY_FREQ_SCALE = 0.6;
const BASE_AMPLITUDE = 1.0;
const COMPOSITE_AMP_SCALE = 0.5;

// ─── Mock Seed Data (only used before a real frame arrives) ──────────────────

function buildMockFrame() {
    const pointCount = 150;
    const positions = new Float32Array(pointCount * 3);
    const clusterLabels: number[] = [];
    const clusterCenters = [-1.2, 0, 1.2];

    for (let i = 0; i < pointCount; i++) {
        const cluster = i % clusterCenters.length;
        positions[i * 3] = clusterCenters[cluster] + (Math.random() - 0.5) * 1.4;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 1.4;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 1.4;
        clusterLabels.push(cluster);
    }

    return { positions, anomalyIndices: [12, 47, 88], clusterLabels };
}

// ─── Instanced Core Geometry (nominal nodes) ─────────────────────────────────

interface CoreNodesProps {
    positions: Float32Array;
    nominalIndices: number[];
    clusterLabels: number[];
}

function InstancedCoreNodes({ positions, nominalIndices, clusterLabels }: CoreNodesProps) {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const count = nominalIndices.length || 1;

    useEffect(() => {
        const mesh = meshRef.current;
        if (!mesh) return;

        const dummy = new THREE.Object3D();
        const pink = new THREE.Color(COLORS.pink);
        const cyan = new THREE.Color(COLORS.cyan);

        nominalIndices.forEach((idx, i) => {
            dummy.position.set(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
            dummy.rotation.set(idx * 0.37, idx * 0.61, 0);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);

            const cluster = clusterLabels[idx] ?? -1;
            mesh.setColorAt(i, cluster >= 0 && cluster % 2 === 1 ? cyan : pink);
        });

        mesh.count = nominalIndices.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }, [positions, nominalIndices, clusterLabels]);

    return (
        <instancedMesh ref={meshRef} args={[undefined, undefined, count]} key={count} frustumCulled={false}>
            <octahedronGeometry args={[0.055, 0]} />
            <meshBasicMaterial transparent opacity={0.55} vertexColors depthWrite={false} />
        </instancedMesh>
    );
}

// ─── Dynamic Volumetric Cluster Hulls ─────────────────────────────────────────

interface HullsProps {
    positions: Float32Array;
    clusterLabels: number[];
}

interface HullEntry {
    key: number;
    geometry: THREE.BufferGeometry;
    edges: THREE.BufferGeometry;
    color: string;
}

function ClusterHulls({ positions, clusterLabels }: HullsProps) {
    const hulls = useMemo<HullEntry[]>(() => {
        const groups = new Map<number, THREE.Vector3[]>();
        for (let i = 0; i < clusterLabels.length; i++) {
            const label = clusterLabels[i];
            if (label < 0) continue; // HDBSCAN noise — no hull
            const pts = groups.get(label) ?? [];
            pts.push(new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
            groups.set(label, pts);
        }

        const entries: HullEntry[] = [];
        let toggle = 0;
        groups.forEach((pts, label) => {
            if (pts.length < 4) return; // need >=4 non-coplanar points for a hull
            try {
                const geometry = new ConvexGeometry(pts);
                const edges = new THREE.EdgesGeometry(geometry);
                entries.push({
                    key: label,
                    geometry,
                    edges,
                    color: toggle++ % 2 === 0 ? COLORS.pink : COLORS.cyan,
                });
            } catch {
                // Degenerate (coplanar) cluster point set — skip hull rendering
            }
        });
        return entries;
    }, [positions, clusterLabels]);

    useEffect(() => {
        return () => {
            hulls.forEach((hull) => {
                hull.geometry.dispose();
                hull.edges.dispose();
            });
        };
    }, [hulls]);

    return (
        <>
            {hulls.map((hull) => (
                <group key={hull.key}>
                    <mesh geometry={hull.geometry}>
                        <meshBasicMaterial
                            color={hull.color}
                            transparent
                            opacity={0.07}
                            side={THREE.DoubleSide}
                            depthWrite={false}
                        />
                    </mesh>
                    <lineSegments geometry={hull.edges}>
                        <lineBasicMaterial color={hull.color} transparent opacity={0.35} />
                    </lineSegments>
                </group>
            ))}
        </>
    );
}

// ─── Vector Tracer Lines (network web) ────────────────────────────────────────

interface TracerProps {
    positions: Float32Array;
    nominalIndices: number[];
    clusterLabels: number[];
}

function TracerLines({ positions, nominalIndices, clusterLabels }: TracerProps) {
    const geometryRef = useRef<THREE.BufferGeometry>(null);

    const segmentPositions = useMemo(() => {
        const centroids = new Map<number, { x: number; y: number; z: number; n: number }>();
        for (const idx of nominalIndices) {
            const label = clusterLabels[idx] ?? -1;
            if (label < 0) continue;
            const c = centroids.get(label) ?? { x: 0, y: 0, z: 0, n: 0 };
            c.x += positions[idx * 3];
            c.y += positions[idx * 3 + 1];
            c.z += positions[idx * 3 + 2];
            c.n += 1;
            centroids.set(label, c);
        }

        const segs = new Float32Array(nominalIndices.length * 6);
        nominalIndices.forEach((idx, i) => {
            const px = positions[idx * 3];
            const py = positions[idx * 3 + 1];
            const pz = positions[idx * 3 + 2];
            const label = clusterLabels[idx] ?? -1;
            const c = label >= 0 ? centroids.get(label) : undefined;
            const tx = c ? c.x / c.n : 0;
            const ty = c ? c.y / c.n : 0;
            const tz = c ? c.z / c.n : 0;

            segs[i * 6] = px;
            segs[i * 6 + 1] = py;
            segs[i * 6 + 2] = pz;
            segs[i * 6 + 3] = tx;
            segs[i * 6 + 4] = ty;
            segs[i * 6 + 5] = tz;
        });
        return segs;
    }, [positions, nominalIndices, clusterLabels]);

    useEffect(() => {
        const geo = geometryRef.current;
        if (!geo || segmentPositions.length === 0) return;
        geo.setAttribute('position', new THREE.BufferAttribute(segmentPositions, 3));
        geo.attributes.position.needsUpdate = true;
        geo.computeBoundingSphere();
    }, [segmentPositions]);

    if (segmentPositions.length === 0) return null;

    return (
        <lineSegments>
            <bufferGeometry ref={geometryRef} />
            <lineBasicMaterial color={COLORS.tracer} transparent opacity={0.12} />
        </lineSegments>
    );
}

// ─── Pulsing Anomaly Beacons ───────────────────────────────────────────────────

interface AnomalyBeaconProps {
    position: [number, number, number];
    temporalRef: MutableRefObject<TemporalMetrics>;
}

function AnomalyBeacon({ position, temporalRef }: AnomalyBeaconProps) {
    const meshRef = useRef<THREE.Mesh>(null);
    const materialRef = useRef<THREE.MeshBasicMaterial>(null);
    const phase = useRef(Math.random() * Math.PI * 2).current;

    useFrame(({ clock }) => {
        // Escalating anomalies (high velocity / composite_smoothed) pulse faster and
        // harder; decaying ones settle back toward the base rate. Read from a ref
        // (not React state) so per-tick temporal updates never re-render the canvas.
        const temporal = temporalRef.current;
        const freqHz = Math.min(MAX_PULSE_HZ, Math.max(BASE_PULSE_HZ, BASE_PULSE_HZ + temporal.velocity * VELOCITY_FREQ_SCALE));
        const amplitude = Math.max(BASE_AMPLITUDE, BASE_AMPLITUDE + temporal.composite_smoothed * COMPOSITE_AMP_SCALE);

        const t = clock.getElapsedTime() * freqHz * (2 * Math.PI) + phase;
        const pulse = 1 + Math.sin(t) * 0.4 * amplitude;

        if (meshRef.current) {
            meshRef.current.scale.setScalar(pulse * 0.1);
            meshRef.current.rotation.x += 0.03;
            meshRef.current.rotation.y += 0.045;
            meshRef.current.position.set(
                position[0] + Math.sin(t * 2.3) * 0.015 * amplitude,
                position[1] + Math.cos(t * 2.7) * 0.015 * amplitude,
                position[2] + Math.sin(t * 3.1) * 0.015 * amplitude,
            );
        }
        if (materialRef.current) {
            materialRef.current.opacity = Math.min(1, Math.max(0.15, 0.55 + Math.sin(t * 1.6) * 0.35 * amplitude));
        }
    });

    return (
        <group>
            <mesh ref={meshRef} position={position}>
                <icosahedronGeometry args={[1, 0]} />
                <meshBasicMaterial ref={materialRef} color={COLORS.anomaly} transparent opacity={0.9} />
            </mesh>
            <Line
                points={[
                    [position[0], BOUNDS_HALF_EXTENT, position[2]],
                    [position[0], -BOUNDS_HALF_EXTENT, position[2]],
                ]}
                color={COLORS.anomaly}
                transparent
                opacity={0.3}
                lineWidth={1}
            />
        </group>
    );
}

interface BeaconsProps {
    positions: Float32Array;
    anomalyIndices: number[];
    temporalRef: MutableRefObject<TemporalMetrics>;
}

function AnomalyBeacons({ positions, anomalyIndices, temporalRef }: BeaconsProps) {
    const pointCount = positions.length / 3;
    const validIndices = useMemo(
        () => anomalyIndices.filter((idx) => idx >= 0 && idx < pointCount),
        [anomalyIndices, pointCount],
    );

    return (
        <>
            {validIndices.map((idx) => (
                <AnomalyBeacon
                    key={idx}
                    position={[positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]]}
                    temporalRef={temporalRef}
                />
            ))}
        </>
    );
}

// ─── Composed Tactical Field ───────────────────────────────────────────────────

interface TacticalFieldProps {
    positions: Float32Array;
    anomalyIndices: number[];
    clusterLabels: number[];
    temporalRef: MutableRefObject<TemporalMetrics>;
}

function TacticalVectorField({ positions, anomalyIndices, clusterLabels, temporalRef }: TacticalFieldProps) {
    const anomalySet = useMemo(() => new Set(anomalyIndices), [anomalyIndices]);
    const nominalIndices = useMemo(() => {
        const count = positions.length / 3;
        const arr: number[] = [];
        for (let i = 0; i < count; i++) {
            if (!anomalySet.has(i)) arr.push(i);
        }
        return arr;
    }, [positions, anomalySet]);

    if (positions.length === 0) return null;

    return (
        <>
            <InstancedCoreNodes positions={positions} nominalIndices={nominalIndices} clusterLabels={clusterLabels} />
            <ClusterHulls positions={positions} clusterLabels={clusterLabels} />
            <TracerLines positions={positions} nominalIndices={nominalIndices} clusterLabels={clusterLabels} />
            <AnomalyBeacons positions={positions} anomalyIndices={anomalyIndices} temporalRef={temporalRef} />
        </>
    );
}

// Bounding box wireframe for spatial reference
function ViewportWireframe() {
    return (
        <mesh>
            <boxGeometry args={[4, 4, 4]} />
            <meshBasicMaterial color="#ffffff" wireframe={true} transparent={true} opacity={0.15} />
        </mesh>
    );
}

// ─── Main Viewport ────────────────────────────────────────────────────────────

export default function VectorViewport() {
    const { positions, anomalyIndices, streamState, liveFrame, temporalRef, narrativeHistory } = useVectorStream();
    const [mockFrame] = useState(buildMockFrame);

    const hasLiveData = positions.length > 0;
    const activePositions = hasLiveData ? positions : mockFrame.positions;
    const activeAnomalyIndices = hasLiveData ? anomalyIndices : mockFrame.anomalyIndices;
    const activeClusterLabels = hasLiveData ? liveFrame?.cluster_labels ?? [] : mockFrame.clusterLabels;

    const pointCount = activePositions.length / 3;
    const regime = liveFrame?.temporal.regime ?? DEFAULT_TEMPORAL_METRICS.regime;
    const regimeColor = HOT_REGIMES.has(regime) ? COLORS.anomaly : COLORS.pink;

    return (
        <div style={{ width: '100%', height: '100%', backgroundColor: '#000000', position: 'relative' }}>
            {/* Minimalist Tech Stats Indicator Overlay */}
            <div style={{
                position: 'absolute', top: 20, left: 20,
                color: '#ffb6c1', fontFamily: 'monospace', fontSize: '12px',
                zIndex: 10, letterSpacing: '1px', pointerEvents: 'none',
            }}>
                VECTOR VIEWPORT // POINTS: {pointCount} // STREAM: {streamState}
            </div>

            <Canvas camera={{ position: [3, 3, 5] }}>
                <ambientLight intensity={0.3} />
                <pointLight position={[10, 10, 10]} intensity={0.7} />
                <ViewportWireframe />
                <TacticalVectorField
                    positions={activePositions}
                    anomalyIndices={activeAnomalyIndices}
                    clusterLabels={activeClusterLabels}
                    temporalRef={temporalRef}
                />
                <OrbitControls enableZoom={true} makeDefault />
            </Canvas>

            {liveFrame && (
                <div className="tactical-terminal-card">
                    <div className="status-header">
                        <span>AI CORE ANALYSIS</span>
                        <span className="regime-tag" style={{ color: regimeColor }}>{regime}</span>
                    </div>
                    {liveFrame.status === 'ANOMALY' && (
                        <p className="explanation-text">{liveFrame.explanation ?? 'analyzing…'}</p>
                    )}
                    {/* Narratives whose frame was already replaced by the time they arrived —
                        surfaced here instead of being dropped silently. */}
                    {narrativeHistory.length > 0 && (
                        <div className="narrative-history">
                            {narrativeHistory.slice(-3).reverse().map((entry, i) => (
                                <p key={`${entry.id}-${i}`} className="narrative-history-entry">
                                    {entry.explanation}
                                </p>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
