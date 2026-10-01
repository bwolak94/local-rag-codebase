import type { ChunkKind } from '../types/index.js'

export function kindFromNodeType(type: string): ChunkKind {
  if (type.includes('function_definition')) return 'function'
  if (type.includes('function')) return 'function'
  if (type.includes('method')) return 'method'
  if (type.includes('class')) return 'class'
  if (type.includes('interface')) return 'interface'
  if (type.includes('type_alias')) return 'type'
  return 'module'
}
