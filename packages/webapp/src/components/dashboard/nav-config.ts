import {
  IconFolder,
  IconSettings,
  IconShield,
  IconCode,
  IconSitemap,
  IconAlertTriangle,
  IconBook,
} from '@tabler/icons-react'

export type NavItem = {
  label: string
  icon: React.ComponentType<{ className?: string }>
  path: string
  params?: Record<string, string>
  exact?: boolean
}

export function getAccountNavItems(): NavItem[] {
  return [
    { label: 'Projects', icon: IconFolder, path: '/dashboard', exact: true },
    { label: 'Settings', icon: IconSettings, path: '/dashboard/settings' },
  ]
}

export function getRepoNavItems(repoId: string): NavItem[] {
  return [
    {
      label: 'Security',
      icon: IconShield,
      path: '/dashboard/repos/$repoId',
      params: { repoId },
      exact: true,
    },
    {
      label: 'Issues',
      icon: IconAlertTriangle,
      path: '/dashboard/repos/$repoId/security/issues',
      params: { repoId },
    },
    {
      label: 'Functions',
      icon: IconCode,
      path: '/dashboard/repos/$repoId/functions',
      params: { repoId },
    },
    {
      label: 'Architecture',
      icon: IconSitemap,
      path: '/dashboard/repos/$repoId/architecture',
      params: { repoId },
    },
    {
      label: 'Learn',
      icon: IconBook,
      path: '/dashboard/repos/$repoId/security/learn',
      params: { repoId },
    },
    {
      label: 'Settings',
      icon: IconSettings,
      path: '/dashboard/repos/$repoId/settings',
      params: { repoId },
    },
  ]
}
