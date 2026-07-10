/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the host-derived backend REST base — see src/lib/apiConfig.ts. */
  readonly VITE_API_BASE?: string
  /** Overrides the host-derived backend WS base — see src/lib/apiConfig.ts. */
  readonly VITE_WS_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
