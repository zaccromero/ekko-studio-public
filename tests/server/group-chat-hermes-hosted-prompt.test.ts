import { describe, expect, it } from 'vitest'
import { buildHostedHermesPrompt } from '../../packages/server/src/modules/studio/services/group-chat/hermes-hosted-prompt'

const parts = {
  instructions: 'Scoped Hermes planning instructions',
  projectContext: 'Project drako-os d2461554 README.md\nProject ekko-studio 6165d6cb ARCHITECTURE.md',
  peerSecurity: '',
  summary: 'Short room summary',
  history: 'Claude: recent raw peer message',
  currentMessage: 'Current message from admin: planning check',
}

describe('hosted Hermes project prompt budget', () => {
  it('keeps the established short-prompt layout unchanged', () => {
    const prompt = buildHostedHermesPrompt(parts)
    expect(prompt).toContain('Room summary:\nShort room summary')
    expect(prompt).toContain('Recent room messages:\nClaude: recent raw peer message')
    expect(prompt).not.toContain('truncated')
  })

  it('keeps both project excerpts, recent peer text and owner message when the old summary is oversized', () => {
    const prompt = buildHostedHermesPrompt({
      ...parts,
      instructions: 'I'.repeat(3_000),
      projectContext: `${parts.projectContext}\n${'P'.repeat(20_400)}`,
      summary: `${'old'.repeat(16_000)}RECENT_SUMMARY_END`,
      history: `${parts.history}\n${'H'.repeat(7_000)}`,
    })
    expect(prompt.length).toBeLessThanOrEqual(64_000)
    expect(prompt).toContain(parts.projectContext)
    expect(prompt).toContain('P'.repeat(20_400))
    expect(prompt).toContain('RECENT_SUMMARY_END')
    expect(prompt).toContain('Claude: recent raw peer message')
    expect(prompt).toContain('Current message from admin: planning check')
    expect(prompt).toContain('Room summary (truncated to fit project context; older text omitted):')
  })

  it('preserves the existing size refusal when no project excerpt was granted', () => {
    expect(() => buildHostedHermesPrompt({ ...parts, projectContext: '', summary: 'S'.repeat(70_000) }))
      .toThrow('Hermes VM room prompt is too large')
  })

  it('refuses when fixed owner, source and recent context alone exceed the limit', () => {
    expect(() => buildHostedHermesPrompt({ ...parts, projectContext: 'P'.repeat(70_000), summary: 'S'.repeat(49_000) }))
      .toThrow('Hermes VM room prompt is too large')
  })
})
