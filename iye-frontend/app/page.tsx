'use client';

/**
 * iye-frontend/app/page.tsx
 * ─────────────────────────
 * Root page — single source of truth for the vector field stream.
 *
 * Architecture
 * ────────────
 *   useVectorField() is called here (not inside VectorCanvas) so that
 *   streamStatus and frame are a single shared state tree, visible
 *   to both VectorCanvas (for the badge) and HUDPanel (for telemetry).
 *
 *   VectorCanvas is dynamically imported (ssr: false) to prevent
 *   Three.js / WebGL from running on the server.
 */

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import HUDPanel from '../components/HUDPanel';
import { RendererTier } from '../components/VectorCanvas';
import { useVectorField } from '../hooks/useVectorField';

// Dynamic import — disables SSR for the Three.js canvas
const VectorCanvas = dynamic(() => import('../components/VectorCanvas'), {
  ssr:     false,
  loading: () => (
    <div
      style={{
        width:          '100%',
        height:         '100%',
        background:     '#121417',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        color:          '#445566',
        fontSize:       12,
        letterSpacing:  '0.1em',
        fontFamily:     'ui-monospace, monospace',
      }}
    >
      initialising renderer…
    </div>
  ),
});

export default function HomePage() {
  const [rendererTier, setRendererTier] = useState<RendererTier>('detecting');

  // Single stream subscription — shared by VectorCanvas and HUDPanel
  const { frame, streamStatus, error } = useVectorField();

  const handleTierResolved = useCallback((tier: RendererTier) => {
    setRendererTier(tier);
  }, []);

  return (
    <main
      style={{
        width:    '100vw',
        height:   '100vh',
        position: 'relative',
        overflow: 'hidden',
        background: '#121417',
      }}
    >
      {/* Full-viewport Three.js canvas */}
      <VectorCanvas
        frame={frame}
        streamStatus={streamStatus}
        onTierResolved={handleTierResolved}
        className="absolute inset-0"
      />

      {/* Floating telemetry overlay */}
      <HUDPanel
        frame={frame}
        rendererTier={rendererTier}
        streamStatus={streamStatus}
      />
    </main>
  );
}
