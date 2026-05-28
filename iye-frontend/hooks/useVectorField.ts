import { useEffect, useState } from 'react';

export interface VectorPoint {
  id: string;
  origin: [number, number, number];
  direction: [number, number, number];
  magnitude: number;
}

export interface FieldFrame {
  timestamp: number;
  vectors: VectorPoint[];
  status: 'nominal' | 'healed' | 'mock';
}

// Client-side local rotating mock generator fallback
async function* mockStreamTick() {
  let frameId = 0;
  while (true) {
    const t = Date.now() * 0.001;
    const mockVectors: VectorPoint[] = Array.from({ length: 60 }, (_, i) => {
      const radius = 4.0;
      const angle = (i * 0.1) + t;
      return {
        id: `mock_${frameId}_${i}`,
        origin: [Math.sin(angle) * radius, (i * 0.1) - 3, Math.cos(angle) * radius],
        direction: [-Math.cos(angle), 0.2, Math.sin(angle)],
        magnitude: 1.5
      };
    });

    yield {
      timestamp: Date.now(),
      vectors: mockVectors,
      status: 'mock' as const
    };
    await new Promise((resolve) => setTimeout(resolve, 33)); // 30 fps fallback
    frameId++;
  }
}

export const useVectorField = (streamUrl: string = 'http://localhost:8787/stream/field') => {
  const [frame, setFrame] = useState<FieldFrame | null>(null);
  const [streamStatus, setStreamStatus] = useState<'connecting' | 'live' | 'healed' | 'mock'>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let mockIterator: AsyncGenerator<FieldFrame> | null = null;
    let isCancelled = false;
    let reconnectTimeout: NodeJS.Timeout;

    const startMockFallback = async () => {
      console.info('backend disconnected; switching to local mock stream layer');
      setStreamStatus('mock');
      mockIterator = mockStreamTick();
      while (!isCancelled) {
        const nextResult = await mockIterator.next();
        if (nextResult.done || isCancelled) break;
        setFrame(nextResult.value);
      }
    };

    const connectToPipeline = () => {
      if (isCancelled) return;
      
      eventSource = new EventSource(streamUrl);

      // GATE 1: On initial connection error (Server completely offline)
      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }

        setError('sse link interrupted');
        setStreamStatus('connecting');
        
        // GATE 2: Wait 2 seconds to attempt exactly one reconnection pass
        console.warn('stream link dropped. attempting 2s reconnect gate...');
        reconnectTimeout = setTimeout(() => {
          if (isCancelled) return;
          // Trigger fallback to mock stream if reconnect pass isn't successful
          startMockFallback();
        }, 2000);
      };

      eventSource.onmessage = (event) => {
        try {
          const parsedData: FieldFrame = JSON.parse(event.data);
          setFrame(parsedData);
          setStreamStatus(parsedData.status === 'healed' ? 'healed' : 'live');
          setError(null);
        } catch (err) {
          setError('failed to parse incoming pipeline frame');
        }
      };
    };

    connectToPipeline();

    return () => {
      isCancelled = true;
      if (eventSource) eventSource.close();
      clearTimeout(reconnectTimeout);
    };
  }, [streamUrl]);

  return { frame, streamStatus, error };
};
