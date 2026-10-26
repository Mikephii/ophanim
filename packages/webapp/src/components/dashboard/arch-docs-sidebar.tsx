import { useState, useEffect } from 'react'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { Collapsible } from 'radix-ui'
import {
  IconBook,
  IconAlertTriangle,
  IconChevronDown,
  IconFolder,
} from '@tabler/icons-react'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import type { ArchitectureHierarchy } from '@/services/api/types'

export function ArchDocsSidebar({
  hierarchy,
  repoId,
}: {
  hierarchy: ArchitectureHierarchy | undefined
  repoId: string
}) {
  const matchRoute = useMatchRoute()

  const isOverviewActive = !!matchRoute({
    to: '/dashboard/repos/$repoId/architecture',
    params: { repoId },
    fuzzy: false,
  })

  if (!hierarchy) {
    return (
      <Sidebar collapsible="none" className="docs-sidebar border-r">
        <SidebarHeader className="px-4 py-3">
          <span className="text-sm font-semibold">Architecture</span>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <p className="px-4 text-xs text-muted-foreground">Loading...</p>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    )
  }

  const hasGroups = hierarchy.groups.length > 0
  const hasConcerns = hierarchy.crossCutting.length > 0

  // Collect grouped community IDs so we can find ungrouped ones
  const groupedIds = new Set(
    hierarchy.groups.flatMap((g) =>
      g.l1Communities.map((c) => c.community_id),
    ),
  )
  const ungrouped = hierarchy.l1.filter(
    (s) => !groupedIds.has(s.community_id),
  )
  const hasUngrouped = ungrouped.length > 0

  return (
    <Sidebar collapsible="none" className="docs-sidebar border-r">
      <SidebarHeader className="px-4 py-3">
        <span className="text-sm font-semibold">Architecture</span>
      </SidebarHeader>
      <SidebarContent>
        {/* Overview link */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isOverviewActive}>
                  <Link
                    to="/dashboard/repos/$repoId/architecture"
                    params={{ repoId }}
                  >
                    <IconBook className="size-4" />
                    <span>Overview</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Grouped L2 → L1 hierarchy */}
        {hasGroups && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {hierarchy.groups.map((group) => (
                  <CollapsibleGroup
                    key={group.groupId}
                    label={group.title}
                    linkTo="/dashboard/repos/$repoId/architecture/groups/$groupId"
                    linkParams={{ repoId, groupId: group.groupId }}
                    isLabelActive={
                      !!matchRoute({
                        to: '/dashboard/repos/$repoId/architecture/groups/$groupId',
                        params: { repoId, groupId: group.groupId },
                      })
                    }
                    hasActiveChild={group.l1Communities.some(
                      (c) =>
                        !!matchRoute({
                          to: '/dashboard/repos/$repoId/architecture/$communityId',
                          params: { repoId, communityId: c.community_id },
                        }),
                    )}
                  >
                    {group.l1Communities.map((community) => (
                      <CommunitySubItem
                        key={community.community_id}
                        community={community}
                        repoId={repoId}
                      />
                    ))}
                  </CollapsibleGroup>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Flat L1 list (no hierarchy) */}
        {!hasGroups && hierarchy.l1.length > 0 && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {hierarchy.l1.map((community) => (
                  <CommunityItem
                    key={community.community_id}
                    community={community}
                    repoId={repoId}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Ungrouped communities as "Other Subsystems" folder */}
        {hasGroups && hasUngrouped && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <CollapsibleGroup
                  label="Other Subsystems"
                  icon={<IconFolder className="size-3.5" />}
                  linkTo="/dashboard/repos/$repoId/architecture/other"
                  linkParams={{ repoId }}
                  isLabelActive={
                    !!matchRoute({
                      to: '/dashboard/repos/$repoId/architecture/other',
                      params: { repoId },
                    })
                  }
                  hasActiveChild={ungrouped.some(
                    (c) =>
                      !!matchRoute({
                        to: '/dashboard/repos/$repoId/architecture/$communityId',
                        params: { repoId, communityId: c.community_id },
                      }),
                  )}
                >
                  {ungrouped.map((community) => (
                    <CommunitySubItem
                      key={community.community_id}
                      community={community}
                      repoId={repoId}
                    />
                  ))}
                </CollapsibleGroup>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Cross-cutting concerns as collapsible folder */}
        {hasConcerns && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <CollapsibleGroup
                  label="Cross-Cutting Concerns"
                  icon={<IconAlertTriangle className="size-3.5" />}
                  linkTo="/dashboard/repos/$repoId/architecture/concerns"
                  linkParams={{ repoId }}
                  isLabelActive={
                    !!matchRoute({
                      to: '/dashboard/repos/$repoId/architecture/concerns',
                      params: { repoId },
                    })
                  }
                  hasActiveChild={hierarchy.crossCutting.some(
                    (c) =>
                      !!matchRoute({
                        to: '/dashboard/repos/$repoId/architecture/concerns/$concernId',
                        params: { repoId, concernId: c.community_id },
                      }),
                  )}
                >
                  {hierarchy.crossCutting.map((concern) => {
                    const isActive = !!matchRoute({
                      to: '/dashboard/repos/$repoId/architecture/concerns/$concernId',
                      params: { repoId, concernId: concern.community_id },
                    })

                    return (
                      <SidebarMenuSubItem key={concern.community_id}>
                        <SidebarMenuSubButton
                          asChild
                          isActive={isActive}
                          size="sm"
                        >
                          <Link
                            to="/dashboard/repos/$repoId/architecture/concerns/$concernId"
                            params={{
                              repoId,
                              concernId: concern.community_id,
                            }}
                          >
                            <span>{concern.summary.title}</span>
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    )
                  })}
                </CollapsibleGroup>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

/** Reusable collapsible folder in the sidebar tree */
function CollapsibleGroup({
  label,
  icon,
  linkTo,
  linkParams,
  isLabelActive,
  hasActiveChild,
  children,
}: {
  label: string
  icon?: React.ReactNode
  linkTo: string
  linkParams: Record<string, string>
  isLabelActive: boolean
  hasActiveChild: boolean
  children: React.ReactNode
}) {
  // Auto-expand when navigating to group or a child; allow manual toggle
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const shouldAutoOpen = isLabelActive || hasActiveChild
  const isOpen = manualOpen ?? shouldAutoOpen

  // Reset manual override when route-based state changes
  useEffect(() => {
    if (shouldAutoOpen) {
      setManualOpen(null)
    }
  }, [shouldAutoOpen])

  return (
    <Collapsible.Root
      open={isOpen}
      onOpenChange={(open) => setManualOpen(open)}
      asChild
    >
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={isLabelActive}>
          <Link to={linkTo as any} params={linkParams as any}>
            <span
              role="button"
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setManualOpen(!isOpen)
              }}
              className="inline-flex items-center justify-center"
            >
              {icon ?? (
                <IconChevronDown
                  className={cn(
                    'size-3.5 transition-transform',
                    !isOpen && '-rotate-90',
                  )}
                />
              )}
            </span>
            <span>{label}</span>
          </Link>
        </SidebarMenuButton>
        <Collapsible.Content className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
          <SidebarMenuSub>{children}</SidebarMenuSub>
        </Collapsible.Content>
      </SidebarMenuItem>
    </Collapsible.Root>
  )
}

function CommunitySubItem({
  community,
  repoId,
}: {
  community: ArchitectureHierarchy['l1'][number]
  repoId: string
}) {
  const matchRoute = useMatchRoute()
  const isActive = !!matchRoute({
    to: '/dashboard/repos/$repoId/architecture/$communityId',
    params: { repoId, communityId: community.community_id },
  })

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={isActive} size="sm">
        <Link
          to="/dashboard/repos/$repoId/architecture/$communityId"
          params={{ repoId, communityId: community.community_id }}
        >
          <span>{community.summary.title}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}

function CommunityItem({
  community,
  repoId,
}: {
  community: ArchitectureHierarchy['l1'][number]
  repoId: string
}) {
  const matchRoute = useMatchRoute()
  const isActive = !!matchRoute({
    to: '/dashboard/repos/$repoId/architecture/$communityId',
    params: { repoId, communityId: community.community_id },
  })

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} size="sm">
        <Link
          to="/dashboard/repos/$repoId/architecture/$communityId"
          params={{ repoId, communityId: community.community_id }}
        >
          <span>{community.summary.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
