import React, { useRef, useMemo, useState, useEffect } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { computeRotationMatrix } from './math/matrix'
import type { VectorFrame } from './math/useVectorStream'

const COLORS = {
  pink: '#ffb6c1',
  magenta: '#ff00ff',
}

const VectorPointCloud: React.FC<{ activeFrame: VectorFrame }> = ({ activeFrame }) => {
  const pointsRef = useRef<THREE.Points>(null)
  const geometryRef = useRef<THREE.BufferGeometry>(null)

  const [positions, setPositions] = useState<Float32Array>(() => new Float32Array(0))
  const [colors, setColors] = useState<Float32Array>(() => new Float32Array(0))

  useEffect(() => {
    const coords = activeFrame.coordinates || []
    const anomalySet = new Set(activeFrame.anomaly_indices)
    const posArray = new Float32Array(coords.length * 3)
    const colorArray = new Float32Array(coords.length * 3)

    // Compute mean to center points
    let sumX = 0, sumY = 0, sumZ = 0
    for (const p of coords) {
      sumX += p.x
      sumY += p.y
      sumZ += p.z
    }
    const meanX = coords.length > 0 ? sumX / coords.length : 0
    const meanY = coords.length > 0 ? sumY / coords.length : 0
    const meanZ = coords.length > 0 ? sumZ / coords.length : 0

    const nominalColor = new THREE.Color(COLORS.pink)
    const anomalyColor = new THREE.Color(COLORS.magenta)

    for (let i = 0; i < coords.length; i++) {
      const p = coords[i]
      posArray[i * 3] = p.x - meanX
      posArray[i * 3 + 1] = p.y - meanY
      posArray[i * 3 + 2] = p.z - meanZ

      const isAnomaly = anomalySet.has(i)
      const color = isAnomaly ? anomalyColor : nominalColor
      colorArray[i * 3] = color.r
      colorArray[i * 3 + 1] = color.g
      colorArray[i * 3 + 2] = color.b
    }

    setPositions(posArray)
    setColors(colorArray)
  }, [activeFrame])

  // Explicitly mark position and color buffer attributes as needing update
  useEffect(() => {
    if (geometryRef.current) {
      const posAttr = geometryRef.current.getAttribute('position') as THREE.BufferAttribute
      const colAttr = geometryRef.current.getAttribute('color') as THREE.BufferAttribute
      if (posAttr) {
        posAttr.needsUpdate = true
      }
      if (colAttr) {
        colAttr.needsUpdate = true
      }
    }
  }, [positions, colors])

  // Custom circular glowing texture
  const particleTexture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 16
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const gradient = ctx.createRadialGradient(8, 8, 0, 8, 8, 8)
      gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 16, 16)
    }
    return new THREE.CanvasTexture(canvas)
  }, [])

  useFrame(({ clock }) => {
    if (pointsRef.current) {
      // Gentle slow rotation when idle
      pointsRef.current.rotation.y = clock.getElapsedTime() * 0.05
    }
  })

  return (
    <points ref={pointsRef}>
      <bufferGeometry ref={geometryRef}>
        <bufferAttribute
          attach="attributes-position"
          count={positions.length / 3}
          array={positions}
          itemSize={3}
        />
        <bufferAttribute
          attach="attributes-color"
          count={colors.length / 3}
          array={colors}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.18}
        map={particleTexture}
        vertexColors
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

const AnimatedVectorGrid: React.FC = () => {
  const meshRef = useRef<THREE.Mesh>(null)

  useFrame(({ clock }) => {
    if (meshRef.current) {
      const time = clock.getElapsedTime()
      const matrix = computeRotationMatrix(time * 0.5)
      meshRef.current.rotation.setFromRotationMatrix(matrix)
    }
  })

  return (
    <mesh ref={meshRef}>
      <boxGeometry args={[2, 2, 2]} />
      <meshBasicMaterial color={COLORS.pink} wireframe />
    </mesh>
  )
}

export interface SceneProps {
  activeFrame: VectorFrame | null
}

export const Scene: React.FC<SceneProps> = ({ activeFrame }) => {
  return (
    <Canvas
      camera={{ position: [0, 0, 5], fov: 60 }}
      style={{ background: '#000000' }}
    >
      <color attach="background" args={['#000000']} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 10, 5]} intensity={0.8} />

      {activeFrame && activeFrame.coordinates && activeFrame.coordinates.length > 0 ? (
        <VectorPointCloud activeFrame={activeFrame} />
      ) : (
        <AnimatedVectorGrid />
      )}
      <OrbitControls enablePan={true} enableZoom={true} />
    </Canvas>
  )
}
