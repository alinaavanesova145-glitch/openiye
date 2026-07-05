import * as THREE from 'three'

/**
 * Computes custom 3D rotation matrix for coordinate tracking.
 */
export function computeRotationMatrix(angle: number): THREE.Matrix4 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  
  // Custom Y-axis rotation matrix
  return new THREE.Matrix4().set(
    c,   0,   s,   0,
    0,   1,   0,   0,
    -s,  0,   c,   0,
    0,   0,   0,   1
  )
}
