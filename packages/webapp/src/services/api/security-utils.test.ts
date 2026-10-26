import { describe, it, expect } from 'vitest'
import {
  severityScore,
  confidenceScore,
  priorityScore,
  priorityLabel,
  flagTier,
} from './security-utils'
import { DISMISS_REASON_LABELS } from './types'
import type { DismissReason } from './types'

describe('severityScore', () => {
  it('returns 3 for error', () => expect(severityScore('error')).toBe(3))
  it('returns 2 for warning', () => expect(severityScore('warning')).toBe(2))
  it('returns 1 for info', () => expect(severityScore('info')).toBe(1))
  it('returns 1 for unknown', () => expect(severityScore('unknown')).toBe(1))
})

describe('confidenceScore', () => {
  it('returns 3 for high', () => expect(confidenceScore('high')).toBe(3))
  it('returns 2 for medium', () => expect(confidenceScore('medium')).toBe(2))
  it('returns 1 for low', () => expect(confidenceScore('low')).toBe(1))
  it('returns 1 for unknown', () => expect(confidenceScore('unknown')).toBe(1))
})

describe('priorityScore', () => {
  it('returns 12 for error+high (P0)', () => {
    expect(priorityScore('error', 'high')).toBe(12)
  })
  it('returns 11 for error+medium', () => {
    expect(priorityScore('error', 'medium')).toBe(11)
  })
  it('returns 9 for warning+high (P1)', () => {
    expect(priorityScore('warning', 'high')).toBe(9)
  })
  it('returns 4 for info+low (P3)', () => {
    expect(priorityScore('info', 'low')).toBe(4)
  })
})

describe('priorityLabel', () => {
  it('returns P0 for score >= 12', () => expect(priorityLabel(12)).toBe('P0'))
  it('returns P1 for score 9-11', () => {
    expect(priorityLabel(9)).toBe('P1')
    expect(priorityLabel(11)).toBe('P1')
  })
  it('returns P2 for score 6-8', () => {
    expect(priorityLabel(6)).toBe('P2')
    expect(priorityLabel(8)).toBe('P2')
  })
  it('returns P3 for score < 6', () => {
    expect(priorityLabel(4)).toBe('P3')
    expect(priorityLabel(5)).toBe('P3')
  })
})

describe('flagTier', () => {
  it('returns tier 1 for sql_injection', () => {
    expect(flagTier('sql_injection')).toBe(1)
  })
  it('returns tier 2 for path_traversal', () => {
    expect(flagTier('path_traversal')).toBe(2)
  })
  it('returns tier 3 for xss', () => {
    expect(flagTier('xss')).toBe(3)
  })
  it('returns tier 4 for prototype_pollution', () => {
    expect(flagTier('prototype_pollution')).toBe(4)
  })
  it('returns tier 3 for unknown flags', () => {
    expect(flagTier('unknown_flag')).toBe(3)
  })
})

describe('DISMISS_REASON_LABELS', () => {
  it('has a label for every dismiss reason', () => {
    const reasons: DismissReason[] = ['false_positive', 'accepted_risk', 'wont_fix']
    for (const reason of reasons) {
      expect(DISMISS_REASON_LABELS[reason]).toBeDefined()
      expect(DISMISS_REASON_LABELS[reason].length).toBeGreaterThan(0)
    }
  })
})

describe('priority matrix completeness', () => {
  const severities = ['error', 'warning', 'info']
  const confidences = ['high', 'medium', 'low']

  it('covers all severity x confidence combinations', () => {
    for (const sev of severities) {
      for (const conf of confidences) {
        const score = priorityScore(sev, conf)
        const label = priorityLabel(score)
        expect(score).toBeGreaterThanOrEqual(4)
        expect(score).toBeLessThanOrEqual(12)
        expect(['P0', 'P1', 'P2', 'P3']).toContain(label)
      }
    }
  })

  it('error+high is always highest priority', () => {
    const p0 = priorityScore('error', 'high')
    for (const sev of severities) {
      for (const conf of confidences) {
        if (sev === 'error' && conf === 'high') continue
        expect(priorityScore(sev, conf)).toBeLessThan(p0)
      }
    }
  })
})
