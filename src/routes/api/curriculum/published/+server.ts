import { json } from '@sveltejs/kit'
import { getPublishedState } from '$lib/server/revisionStore'

export async function GET() {
  const state = await getPublishedState()
  return json(state)
}
