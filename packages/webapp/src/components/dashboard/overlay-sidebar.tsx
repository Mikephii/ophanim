import { useState } from 'react'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { useTheme } from '@/hooks/use-theme'
import { IconSun, IconMoon, IconMenu2 } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import type { NavItem } from './nav-config'

export function OverlaySidebar({
  children,
  navItems,
}: {
  children: React.ReactNode
  navItems: NavItem[]
}) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <MobileSidebar navItems={navItems}>
        {children}
      </MobileSidebar>
    )
  }

  return (
    <div className="flex min-h-[calc(100vh-48px)]">
      <DesktopSidebar navItems={navItems} />
      <div className="flex-1 pl-14">{children}</div>
    </div>
  )
}

function DesktopSidebar({ navItems }: { navItems: NavItem[] }) {
  const [expanded, setExpanded] = useState(false)
  const { theme, toggleTheme } = useTheme()
  const matchRoute = useMatchRoute()

  return (
    <nav
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      className={cn(
        'fixed top-12 left-0 bottom-0 z-30 flex flex-col',
        'border-r border-border bg-background overflow-hidden',
        'transition-[width] duration-200 ease-in-out',
        expanded ? 'w-[240px] shadow-lg' : 'w-14',
      )}
    >
      <div className="flex flex-1 flex-col gap-0.5 p-2 overflow-y-auto overflow-x-hidden">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = !!matchRoute({
            to: item.path as any,
            params: item.params,
            fuzzy: !item.exact,
          })

          return (
            <Link
              key={item.path + JSON.stringify(item.params)}
              to={item.path as any}
              params={item.params as any}
              className={cn(
                'flex items-center gap-3 rounded-none px-3 h-9',
                'transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span
                className={cn(
                  'truncate whitespace-nowrap text-sm transition-opacity duration-150',
                  expanded ? 'opacity-100' : 'opacity-0',
                )}
              >
                {item.label}
              </span>
            </Link>
          )
        })}
      </div>

      <div className="p-2 border-t border-border">
        <button
          onClick={toggleTheme}
          className={cn(
            'flex items-center gap-3 rounded-none px-3 h-9 w-full',
            'text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
          )}
        >
          {theme === 'dark' ? (
            <IconSun className="size-4 shrink-0" />
          ) : (
            <IconMoon className="size-4 shrink-0" />
          )}
          <span
            className={cn(
              'truncate whitespace-nowrap text-sm transition-opacity duration-150',
              expanded ? 'opacity-100' : 'opacity-0',
            )}
          >
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </span>
        </button>
      </div>
    </nav>
  )
}

function MobileSidebar({
  children,
  navItems,
}: {
  children: React.ReactNode
  navItems: NavItem[]
}) {
  const [open, setOpen] = useState(false)
  const matchRoute = useMatchRoute()

  return (
    <>
      <div className="fixed top-12 left-0 right-0 z-20 flex items-center h-10 px-3 border-b border-border bg-background">
        <Button
          variant="ghost"
          size="sm"
          className="size-8 p-0"
          onClick={() => setOpen(true)}
        >
          <IconMenu2 className="size-4" />
        </Button>
      </div>
      <div className="pt-10">{children}</div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[260px] p-0">
          <SheetHeader className="p-4 pb-2">
            <SheetTitle className="text-sm">Navigation</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-0.5 p-2">
            {navItems.map((item) => {
              const Icon = item.icon
              const isActive = !!matchRoute({
                to: item.path as any,
                params: item.params,
                fuzzy: !item.exact,
              })

              return (
                <Link
                  key={item.path + JSON.stringify(item.params)}
                  to={item.path as any}
                  params={item.params as any}
                  onClick={() => setOpen(false)}
                  className={cn(
                    'flex items-center gap-3 rounded-none px-3 h-9 text-sm',
                    'transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              )
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
