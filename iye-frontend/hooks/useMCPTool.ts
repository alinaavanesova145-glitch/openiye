import { useState } from 'react';

export interface FieldStatsResult {
  num_vectors: number;
  mean_magnitude: number;
  max_magnitude: number;
  centroid_x: number;
  centroid_y: number;
  centroid_z: number;
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
  min_z?: number;
  max_z?: number;
}

export const MCP_TOOL_SCHEMA = {
  name: "field_stats",
  description: "analyzes raw multi-dimensional geometric matrix data arrays for bounds and centroids",
  inputschema: {
    type: "object",
    properties: {
      field: {
        type: "array",
        items: { type: "array", items: { type: "number" } },
        description: "raw vector coordinate array stack"
      }
    },
    required: ["field"]
  }
};

export function useMCPTool<T>(methodName: string = 'field_stats') {
  const [isLoading, setIsLoading] = useState(false);
  const [toolResult, setToolResult] = useState<T | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);

  const invoke = async (params: Record<string, any>): Promise<T | null> => {
    setIsLoading(true);
    setToolError(null);
    try {
      const response = await fetch('http://localhost:8787/tool/field_stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Math.floor(Math.random() * 100000),
          method: methodName,
          params: params
        })
      });
      const data = await response.json();
      if (data.error) {
        console.error("mcp tool execution error:", data.error.message);
        setToolError(data.error.message);
        return null;
      }
      setToolResult(data.result as T);
      return data.result as T;
    } catch (err) {
      console.error("failed to transmit mcp payload envelope:", err);
      setToolError("failed to transmit mcp payload envelope");
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  // Return both structures so that HUDPanel.tsx and any other agent calls remain fully compliant and functional!
  return { 
    invoke, 
    invokeTool: invoke, // Alias invoke to invokeTool for HUDPanel
    toolResult, 
    isLoading, 
    toolError 
  };
}
