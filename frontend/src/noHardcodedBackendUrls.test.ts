/**
 * noHardcodedBackendUrls — architecture-fitness test (2026-08-01 sprint).
 *
 * @lib/apiConfig.ts is the single source of truth for how the frontend
 * addresses the backend (derived from window.location, with
 * VITE_API_BASE/VITE_WS_BASE overrides — see that file's docstring for
 * the 2026-07-14 sprint bug this replaced: a hardcoded 127.0.0.1 literal
 * meant nothing worked when opened from a LAN peer). This test scans the
 * actual source tree at test-run time and fails if a hardcoded backend
 * host/URL literal is ever reintroduced anywhere else — a regression here
 * would silently break both the LAN-access case this file was written for
 * and the newer public-Cloudflare-Pages case (@lib/apiConfig's
 * IS_PUBLIC_HOST notice, see App.test.tsx), since either could bypass
 * apiConfig's derivation entirely.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname)

// apiConfig.ts is where these patterns are *supposed* to live; its own
// test file legitimately uses them as literal test inputs/expectations
// for computeApiBase/computeWsBase.
const EXCLUDED_FILES = new Set(['lib/apiConfig.ts', 'lib/apiConfig.test.ts'])

const FORBIDDEN_PATTERNS = [
  /127\.0\.0\.1/,
  /\blocalhost:8050\b/,
  /ws:\/\/[a-zA-Z0-9]/,
  /wss:\/\/[a-zA-Z0-9]/,
  /http:\/\/[a-zA-Z0-9]/,
  /https:\/\/[a-zA-Z0-9].*:8050/,
]

function listSourceFiles(dir: string, relativeTo: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(fullPath, relativeTo))
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(fullPath.slice(relativeTo.length + 1))
    }
  }
  return files
}

describe('no hardcoded backend URLs outside apiConfig.ts', () => {
  const files = listSourceFiles(SRC_DIR, SRC_DIR).filter((f) => !EXCLUDED_FILES.has(f))

  it('found a non-trivial number of source files to scan (sanity check on the scan itself)', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it.each(files)('%s has no hardcoded backend host/URL literal', (relativePath) => {
    const content = readFileSync(join(SRC_DIR, relativePath), 'utf-8')
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(
        pattern.test(content),
        `${relativePath} matched forbidden pattern ${pattern.toString()} — backend addressing must go through @lib/apiConfig's API_BASE/WS_BASE, not a hardcoded literal`,
      ).toBe(false)
    }
  })
})
