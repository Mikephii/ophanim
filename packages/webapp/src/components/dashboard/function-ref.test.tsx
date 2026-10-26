import { render, screen } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { FunctionRef, openVSCodeUri } from './function-ref'

// Mock TanStack Router Link to render as a plain <a> tag
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: React.ReactNode
    to: string
    params: Record<string, string>
    className?: string
  }) => {
    let href = to
    for (const [key, value] of Object.entries(params ?? {})) {
      href = href.replace(`$${key}`, value)
    }
    return (
      <a href={href} {...props}>
        {children}
      </a>
    )
  },
}))

// Mock useBasePath hook
const mockSetBasePath = vi.fn()
let mockBasePath: string | null = null

vi.mock('@/hooks/use-base-path', () => ({
  useBasePath: () => [mockBasePath, mockSetBasePath],
}))

beforeEach(() => {
  mockBasePath = null
  mockSetBasePath.mockClear()
})

describe('openVSCodeUri', () => {
  let openSpy: { mockRestore(): void; mock: { calls: unknown[][] } }

  beforeEach(() => {
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  it('constructs basic URI without line number', () => {
    openVSCodeUri('/Users/me/repo', 'src/auth.ts')
    expect(openSpy).toHaveBeenCalledWith(
      'vscode://file//Users/me/repo/src/auth.ts',
      '_self',
    )
  })

  it('appends line and column when startLine is provided', () => {
    openVSCodeUri('/Users/me/repo', 'src/auth.ts', 42)
    expect(openSpy).toHaveBeenCalledWith(
      'vscode://file//Users/me/repo/src/auth.ts:42:1',
      '_self',
    )
  })

  it('omits line suffix when startLine is 0', () => {
    openVSCodeUri('/Users/me/repo', 'src/auth.ts', 0)
    expect(openSpy).toHaveBeenCalledWith(
      'vscode://file//Users/me/repo/src/auth.ts',
      '_self',
    )
  })

  it('omits line suffix when startLine is undefined', () => {
    openVSCodeUri('/Users/me/repo', 'src/auth.ts', undefined)
    expect(openSpy).toHaveBeenCalledWith(
      'vscode://file//Users/me/repo/src/auth.ts',
      '_self',
    )
  })

  it('cleans trailing slash on basePath and leading slash on filePath', () => {
    openVSCodeUri('/Users/me/repo/', '/src/auth.ts', 10)
    expect(openSpy).toHaveBeenCalledWith(
      'vscode://file//Users/me/repo/src/auth.ts:10:1',
      '_self',
    )
  })
})

describe('FunctionRef', () => {
  it('renders function name with parentheses', () => {
    render(
      <FunctionRef
        functionName="handleAuth"
        contentHash="abc123"
        repoId="repo-1"
      />,
    )

    expect(screen.getByText('handleAuth()')).toBeDefined()
  })

  it('renders a link to the function detail page', () => {
    render(
      <FunctionRef
        functionName="handleAuth"
        contentHash="abc123"
        repoId="repo-1"
      />,
    )

    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe(
      '/dashboard/repos/repo-1/fn/abc123',
    )
  })

  it('does not render editor button when filePath is not provided', () => {
    render(
      <FunctionRef
        functionName="handleAuth"
        contentHash="abc123"
        repoId="repo-1"
      />,
    )

    expect(
      screen.queryByRole('button', { name: /open in editor/i }),
    ).toBeNull()
  })

  it('renders editor button when filePath is provided', () => {
    render(
      <FunctionRef
        functionName="handleAuth"
        contentHash="abc123"
        repoId="repo-1"
        filePath="src/auth.ts"
      />,
    )

    expect(
      screen.getByRole('button', { name: /open in editor/i }),
    ).toBeDefined()
  })
})
