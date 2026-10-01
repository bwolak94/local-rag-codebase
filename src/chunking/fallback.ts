import { chunkHash, chunkId } from '../ingest/hasher.js'
import type { Chunk, Chunker, SourceFile } from '../types/index.js'

export class SlidingWindowChunker implements Chunker {
  constructor(
    private windowLines = 60,
    private overlapLines = 10,
  ) {
    if (overlapLines >= windowLines) {
      throw new Error(
        `SlidingWindowChunker: overlapLines (${overlapLines}) must be less than windowLines (${windowLines})`
      )
    }
  }

  supports(_file: SourceFile): boolean {
    return true // universal fallback
  }

  async chunk(file: SourceFile): Promise<Chunk[]> {
    const lines = file.content.split('\n')
    const chunks: Chunk[] = []
    const step = this.windowLines - this.overlapLines

    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(start + this.windowLines - 1, lines.length - 1)
      const content = lines.slice(start, end + 1).join('\n')
      if (!content.trim()) continue

      const startLine = start + 1
      const endLine = end + 1
      const header = `file:${file.path} lines:${startLine}-${endLine} lang:${file.lang}`
      const id = chunkId(file.path, undefined, startLine)

      chunks.push({
        id,
        path: file.path,
        lang: file.lang,
        kind: 'text',
        startLine,
        endLine,
        header,
        content,
        hash: chunkHash(header, content),
      })
    }

    return chunks
  }
}
