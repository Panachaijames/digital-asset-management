import AppShell from "@/components/AppShell";
import TagSettings from "@/components/TagSettings";

export default function SettingsPage() {
  return (
    <AppShell crumb="Taxonomy">
      <div className="h-full overflow-y-auto">
        {/* Fluid width, 32px panel padding, no centred column. */}
        <div className="px-8 py-8 pb-12">
          <TagSettings />
        </div>
      </div>
    </AppShell>
  );
}
