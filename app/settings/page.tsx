import AppShell from "@/components/AppShell";
import TagSettings from "@/components/TagSettings";

export default function SettingsPage() {
  return (
    <AppShell crumb="Settings">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-6">
          <TagSettings />
        </div>
      </div>
    </AppShell>
  );
}
