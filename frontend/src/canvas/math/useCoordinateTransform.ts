import { useMemo } from 'react';
import * as THREE from 'three';

export function useCoordinateTransform(matrixData: number[]): THREE.Matrix4 {
  return useMemo(() => {
    const matrix = new THREE.Matrix4();
    if (matrixData.length === 9) {
      // Map 3x3 matrix elements to a 4x4 Three.js Matrix4
      matrix.set(
        matrixData[0], matrixData[1], matrixData[2], 0,
        matrixData[3], matrixData[4], matrixData[5], 0,
        matrixData[6], matrixData[7], matrixData[8], 0,
        0,             0,             0,             1
      );
    } else if (matrixData.length === 16) {
      matrix.fromArray(matrixData);
    }
    return matrix;
  }, [matrixData]);
}
