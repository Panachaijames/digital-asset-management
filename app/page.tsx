import AppShell from "@/components/AppShell";
import ImageUploader from "@/components/ImageUploader";

export default function Home() {
  return (
    <AppShell crumb="Upload">
      <div className="h-full overflow-y-auto">
        <ImageUploader />
      </div>
    </AppShell>
  );
}
