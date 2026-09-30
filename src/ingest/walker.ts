import { execSync } from 'node:child_process'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import ignore from 'ignore'
import { minimatch } from 'minimatch'
import { contentHash } from './hasher.js'
import type { SourceFile } from '../types/index.js'

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.php': 'php', '.vue': 'vue',
  '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.css': 'css', '.html': 'html',
}

const SECRET_PATTERNS = [
  /\.env($|\.)/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/,
  /\/(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/, /\.secret$/,
]

export function detectLang(path: string): string {
  return LANG_MAP[extname(path).toLowerCase()] ?? 'text'
}

function shouldIndex(path: string): boolean {
  return !SECRET_PATTERNS.some(p => p.test(path))
}

export async function collectFiles(
  root: string,
  include: string[],
  exclude: string[],
  maxFileBytes: number
): Promise<SourceFile[]> {
  const ig = ignore().add(exclude)
  let paths: string[]

  try {
    const out = execSync('git ls-files', { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    paths = out.trim().split('\n').filter(Boolean)
  } catch {
    // not a git repo — skip for now, git ls-files is required for MVP
    throw new Error('git ls-files failed: must run inside a git repository')
  }

  const results: SourceFile[] = []
  for (const rel of paths) {
    if (!shouldIndex(rel)) continue
    if (ig.ignores(rel)) continue

    // apply include patterns using proper glob matching
    const matchesInclude = include.length === 0 ||
      include.some(pat => minimatch(rel, pat, { matchBase: true, dot: true }))
    if (!matchesInclude) continue

    const abs = resolve(root, rel)
    if (!existsSync(abs)) continue

    const stat = statSync(abs)
    if (stat.size > maxFileBytes) continue

    const content = readFileSync(abs, 'utf8')
    results.push({
      path: rel,
      lang: detectLang(rel),
      content,
      hash: contentHash(content),
    })
  }

  return results
}
