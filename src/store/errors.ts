export class ModelMismatchError extends Error {
  constructor(stored: string, current: string) {
    super(`Embedding model mismatch: index was built with "${stored}", current model is "${current}". Run \`rag index --full\` to rebuild.`)
    this.name = 'ModelMismatchError'
  }
}
