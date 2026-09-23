import AppShell from "@/components/AppShell";
import DriveImport from "@/components/DriveImport";

export default function ImportPage() {
  return (
    <AppShell crumb="Import">
      <div className="h-full overflow-y-auto">
        <DriveImport />
      </div>
    </AppShell>
  );
}
