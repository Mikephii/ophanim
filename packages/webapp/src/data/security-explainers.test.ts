import { describe, it, expect } from 'vitest'
import { SECURITY_EXPLAINERS } from './security-explainers'
import { KNOWN_SECURITY_FLAGS, SECURITY_FLAG_LABELS } from '@ophan/core/schemas'

describe('SECURITY_EXPLAINERS', () => {
  it('has an entry for every KNOWN_SECURITY_FLAGS member', () => {
    for (const flag of KNOWN_SECURITY_FLAGS) {
      expect(SECURITY_EXPLAINERS[flag]).toBeDefined()
    }
  })

  it('has all required fields populated for every explainer', () => {
    for (const [flag, explainer] of Object.entries(SECURITY_EXPLAINERS)) {
      expect(explainer.flag).toBe(flag)
      expect(explainer.title.length).toBeGreaterThan(0)
      expect(explainer.tier).toBeGreaterThanOrEqual(1)
      expect(explainer.tier).toBeLessThanOrEqual(4)
      expect(explainer.whatIsIt.length).toBeGreaterThan(0)
      expect(explainer.howItWorks.length).toBeGreaterThan(0)
      expect(explainer.vulnerableCode.length).toBeGreaterThan(0)
      expect(explainer.safeCode.length).toBeGreaterThan(0)
      expect(explainer.frameworkNotes.length).toBeGreaterThan(0)
      expect(explainer.references.length).toBeGreaterThan(0)
    }
  })

  it('has titles matching SECURITY_FLAG_LABELS', () => {
    for (const [flag, explainer] of Object.entries(SECURITY_EXPLAINERS)) {
      expect(explainer.title).toBe(SECURITY_FLAG_LABELS[flag])
    }
  })

  it('has valid CWE identifiers', () => {
    for (const explainer of Object.values(SECURITY_EXPLAINERS)) {
      expect(explainer.cwe).toMatch(/^CWE-\d+$/)
    }
  })

  it('has valid OWASP identifiers', () => {
    for (const explainer of Object.values(SECURITY_EXPLAINERS)) {
      expect(explainer.owasp).toMatch(/^A\d{2}:\d{4}$/)
    }
  })

  it('has valid reference URLs', () => {
    for (const explainer of Object.values(SECURITY_EXPLAINERS)) {
      for (const ref of explainer.references) {
        expect(ref.title.length).toBeGreaterThan(0)
        expect(ref.url).toMatch(/^https?:\/\//)
      }
    }
  })
})
