import { useState, useCallback, useEffect } from 'react'

function getStorageKey(repoId: string): string {
  return `ophan:basePath:${repoId}`
}

function getInitialBasePath(repoId: string): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(getStorageKey(repoId))
}

const EVENT_NAME = 'ophan:basepath-changed'

export function useBasePath(
  repoId: string,
): [string | null, (path: string) => void] {
  const [basePath, setBasePathState] = useState<string | null>(() =>
    getInitialBasePath(repoId),
  )

  const setBasePath = useCallback(
    (path: string) => {
      setBasePathState(path)
      localStorage.setItem(getStorageKey(repoId), path)
      // Notify other hook instances on the same page
      window.dispatchEvent(
        new CustomEvent(EVENT_NAME, { detail: { repoId, path } }),
      )
    },
    [repoId],
  )

  // Sync state when another hook instance updates the value
  useEffect(() => {
    function handleChange(e: Event) {
      const { repoId: changedRepo, path } = (e as CustomEvent).detail
      if (changedRepo === repoId) {
        setBasePathState(path)
      }
    }
    window.addEventListener(EVENT_NAME, handleChange)
    return () => window.removeEventListener(EVENT_NAME, handleChange)
  }, [repoId])

  return [basePath, setBasePath]
}
