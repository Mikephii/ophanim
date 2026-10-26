import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBasePath } from './use-base-path'

beforeEach(() => {
  localStorage.clear()
})

describe('useBasePath', () => {
  it('returns null when no localStorage value exists', () => {
    const { result } = renderHook(() => useBasePath('repo-1'))
    expect(result.current[0]).toBeNull()
  })

  it('returns stored value when localStorage has a value', () => {
    localStorage.setItem('ophan:basePath:repo-1', '/Users/me/code/my-app')
    const { result } = renderHook(() => useBasePath('repo-1'))
    expect(result.current[0]).toBe('/Users/me/code/my-app')
  })

  it('setBasePath updates state and localStorage', () => {
    const { result } = renderHook(() => useBasePath('repo-1'))
    expect(result.current[0]).toBeNull()

    act(() => {
      result.current[1]('/Users/me/code/my-app')
    })

    expect(result.current[0]).toBe('/Users/me/code/my-app')
    expect(localStorage.getItem('ophan:basePath:repo-1')).toBe(
      '/Users/me/code/my-app',
    )
  })

  it('syncs across multiple hook instances on the same page', () => {
    const { result: instance1 } = renderHook(() => useBasePath('repo-1'))
    const { result: instance2 } = renderHook(() => useBasePath('repo-1'))

    expect(instance1.current[0]).toBeNull()
    expect(instance2.current[0]).toBeNull()

    // Setting via instance1 should update instance2 via custom event
    act(() => {
      instance1.current[1]('/Users/me/code/my-app')
    })

    expect(instance1.current[0]).toBe('/Users/me/code/my-app')
    expect(instance2.current[0]).toBe('/Users/me/code/my-app')
  })

  it('uses different keys for different repoIds', () => {
    localStorage.setItem('ophan:basePath:repo-a', '/path/a')
    localStorage.setItem('ophan:basePath:repo-b', '/path/b')

    const { result: resultA } = renderHook(() => useBasePath('repo-a'))
    const { result: resultB } = renderHook(() => useBasePath('repo-b'))
    const { result: resultC } = renderHook(() => useBasePath('repo-c'))

    expect(resultA.current[0]).toBe('/path/a')
    expect(resultB.current[0]).toBe('/path/b')
    expect(resultC.current[0]).toBeNull()
  })
})
