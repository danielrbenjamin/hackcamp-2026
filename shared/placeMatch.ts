function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{Mark}/gu, '').toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim()
}

export function chooseSiriPlace<T extends { label: string; name?: string }>(query: string, places: readonly T[]): T | null {
  const normalized = normalize(query)
  if (!normalized) return null
  const exact = places.filter(place => normalize(place.label) === normalized || normalize(place.name ?? '') === normalized)
  return exact.length === 1 ? exact[0] : null
}
