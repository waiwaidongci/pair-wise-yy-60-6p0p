import { NextResponse } from 'next/server';
import { evidenceResponseSchema, mutationRequestSchema } from '@/lib/schema';
import { summarize } from '@/lib/domain';
import { applyClientMutation, getState } from '@/lib/serverStore';

export const dynamic = 'force-dynamic';

export async function GET() {
  const state = getState();
  return NextResponse.json(evidenceResponseSchema.parse({ state, summary: summarize(state) }));
}

export async function POST(request: Request) {
  const parsed = mutationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ accepted: false, reason: 'invalid', message: '请求格式不正确' }, { status: 400 });
  }
  const { clientId, actor, mutation } = parsed.data;
  const result = applyClientMutation(clientId, mutation, actor);
  const body = { ...result, summary: summarize(result.state) };
  if (result.accepted) return NextResponse.json(body);
  if (result.reason === 'revision-conflict') return NextResponse.json(body, { status: 409 });
  if (result.reason === 'gate-blocked') return NextResponse.json(body, { status: 422 });
  return NextResponse.json(body, { status: 400 });
}
