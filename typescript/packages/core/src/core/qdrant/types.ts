export type QdrantRow = Record<string, unknown>

export interface QdrantPoint {
  id: string | number
  payload?: QdrantRow | null
  score?: number
}

export type PointTest = (point: QdrantPoint) => boolean
