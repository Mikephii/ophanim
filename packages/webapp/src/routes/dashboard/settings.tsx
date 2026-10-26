import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="text-muted-foreground mt-1">
        Account and team settings will appear here.
      </p>
    </div>
  )
}
