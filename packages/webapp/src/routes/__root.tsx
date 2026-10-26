import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { isomorphicGetSBSession } from '@/utils/supabase/isomorphicSupabaseSession'
import type { RootContext } from '@/router'
import { getPublicConfig, publicConfigScript } from '@/utils/public-config'

import appCss from '../styles.css?url'

export const Route = createRootRouteWithContext<RootContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Ophan' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/png', href: '/ophan_logo.png' },
    ],
  }),
  beforeLoad: async () => {
    const authSession = await isomorphicGetSBSession()
    return { authSession }
  },
  component: RootComponent,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Same value on server and client (the client reads back what the server rendered), so hydration matches */}
        <script dangerouslySetInnerHTML={{ __html: publicConfigScript(getPublicConfig()) }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('theme');
                  if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                    document.documentElement.classList.add('dark');
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function RootComponent() {
  return <Outlet />
}
