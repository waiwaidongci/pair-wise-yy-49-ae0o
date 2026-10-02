import { json } from '@sveltejs/kit'
import { getState } from '$lib/server/revisionStore'

export async function GET() {
  const state = await getState()
  return json(state)
}
