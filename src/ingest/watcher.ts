import chokidar from 'chokidar'
import { relative } from 'node:path'
import { minimatch } from 'minimatch'

export interface WatcherOptions {
  root: string
  include: string[]
  exclude: string[]
  debounceMs?: number
  onChanges: (paths: string[]) => Promise<void>
}

export function createWatcher(opts: WatcherOptions): { close(): void } {
  const { root, exclude, debounceMs = 500, onChanges } = opts

  const pending = new Set<string>()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let isFlushing = false

  const flush = async () => {
    if (isFlushing) {
      // re-schedule: another flush is already running
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => { void flush() }, debounceMs)
      return
    }
    isFlushing = true
    try {
      const paths = [...pending].map(abs => relative(root, abs))
      pending.clear()
      await onChanges(paths)
    } finally {
      isFlushing = false
    }
  }

  const schedule = (path: string) => {
    pending.add(path)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { void flush() }, debounceMs)
  }

  const ignoredFn = (filePath: string): boolean => {
    const rel = relative(root, filePath)
    return exclude.some(pattern => minimatch(rel, pattern, { dot: true }))
  }

  const watcher = chokidar.watch(root, {
    ignored: [
      /(node_modules|\.git|\.rag|dist)/,
      /(\.env|\.pem|\.key|\.p12|\.pfx)/,
      ignoredFn,
    ],
    ignoreInitial: true,
    persistent: true,
  })

  watcher
    .on('add', schedule)
    .on('change', schedule)
    .on('unlink', schedule)

  return {
    close() {
      if (debounceTimer) clearTimeout(debounceTimer)
      void watcher.close()
    },
  }
}
