import { useState, useEffect, useCallback } from 'react'

type Theme = 'light' | 'dark'

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  const stored = localStorage.getItem('theme') as Theme | null
  if (stored) return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function useTheme() {
  // The server can't know the stored or system theme, so the first client render must
  // match the server's ('light'); the real theme is read after mount. The inline script
  // in __root.tsx has already set the <html> class, so there is no flash.
  const [storedTheme, setThemeState] = useState<Theme | null>(null)
  const theme: Theme = storedTheme ?? 'light'

  useEffect(() => {
    setThemeState(getInitialTheme())
  }, [])

  useEffect(() => {
    if (storedTheme) document.documentElement.classList.toggle('dark', storedTheme === 'dark')
  }, [storedTheme])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    localStorage.setItem('theme', t)
    document.documentElement.classList.toggle('dark', t === 'dark')
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }, [theme, setTheme])

  return { theme, setTheme, toggleTheme }
}
